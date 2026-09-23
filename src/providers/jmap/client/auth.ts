import type { Credentials } from '../../../domain/account'
import { t } from '../../../lib/i18n'
import { JmapError } from './errors'

/*
 * How a request is authorised, and the token login that replaces a stored
 * password where the server offers one (issue #97).
 *
 * Basic and bearer credentials are a fixed header. An `oauth` credential is a
 * refresh token: the access token it buys lives only in memory here, is
 * renewed shortly before it expires, and once more when a request comes back
 * 401 anyway (revoked, or the clock is off). One renewal per token at a time —
 * a sync, the event stream and a download all asking at once share it.
 *
 * The login is Stalwart's structured endpoint, the one its own web admin
 * uses, straight from the browser: `POST /api/auth` with the password (and a
 * TOTP code where the account has one) answers with an authorization code,
 * which `/auth/token` trades for the tokens, PKCE standing in for a client
 * secret. Servers without it keep Basic auth.
 */

/** The client id mel presents. Stalwart takes any, unregistered. */
export const CLIENT_ID = 'mel'

/** Renew this long before the server's expiry rather than on it. */
const EARLY_MS = 60_000

const held = new Map<string, { header: string; expiresAt: number }>()
const renewing = new Map<string, Promise<string>>()

let rotated: ((previous: string, creds: Credentials) => void) | null = null

/**
 * Called when the server hands out a new refresh token with a renewal, so the
 * stored one can be replaced. The credentials object itself is updated in
 * place, which keeps every transport holding it working.
 */
export function onRefreshTokenRotated(fn: typeof rotated): void {
  rotated = fn
}

export function authHeader(creds: Credentials): string {
  if (creds.method === 'bearer') return `Bearer ${creds.secret}`
  return `Basic ${btoa(`${creds.username ?? ''}:${creds.secret}`)}`
}

interface TokenAnswer {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  error?: string
}

function hold(refreshToken: string, answer: TokenAnswer): string {
  const header = `Bearer ${answer.access_token}`
  held.set(refreshToken, { header, expiresAt: Date.now() + (answer.expires_in ?? 3600) * 1000 })
  return header
}

async function requestAccessToken(creds: Credentials): Promise<string> {
  if (!creds.tokenEndpoint) throw new JmapError(t('auth.expired'), 'auth', undefined, 401)
  let res: Response
  try {
    res = await fetch(creds.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.secret,
        client_id: creds.clientId ?? CLIENT_ID,
      }),
    })
  } catch (e) {
    throw new JmapError(e instanceof Error ? e.message : 'network error', 'network')
  }
  // An outage is not a sign-out: only the server refusing the token is.
  if (res.status === 429) throw new JmapError(`HTTP ${res.status}`, 'ratelimit', undefined, 429)
  if (res.status >= 500) throw new JmapError(`HTTP ${res.status}`, 'server', undefined, res.status)
  const answer = (await res.json().catch(() => ({}))) as TokenAnswer
  if (!res.ok || !answer.access_token) {
    throw new JmapError(t('auth.expired'), 'auth', undefined, 401)
  }
  if (answer.refresh_token && answer.refresh_token !== creds.secret) {
    const previous = creds.secret
    held.delete(previous)
    creds.secret = answer.refresh_token
    rotated?.(previous, creds)
  }
  return hold(creds.secret, answer)
}

function renew(creds: Credentials): Promise<string> {
  const key = creds.secret
  let pending = renewing.get(key)
  if (!pending) {
    pending = requestAccessToken(creds).finally(() => renewing.delete(key))
    renewing.set(key, pending)
  }
  return pending
}

/** The Authorization header for the next request, renewing a token first if due. */
export async function authorization(creds: Credentials): Promise<string> {
  if (creds.method !== 'oauth') return authHeader(creds)
  const current = held.get(creds.secret)
  if (current && current.expiresAt - EARLY_MS > Date.now()) return current.header
  return renew(creds)
}

/**
 * `fetch` with the account's authorisation, renewing and retrying once when a
 * token is refused. Answers with the response whatever its status — callers
 * keep their own error handling — and throws a `JmapError` only when a token
 * could not be renewed.
 */
export async function authorizedFetch(
  creds: Credentials,
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const send = (header: string) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', header)
    return fetch(url, { ...init, headers })
  }
  const header = await authorization(creds)
  const res = await send(header)
  if (res.status !== 401 || creds.method !== 'oauth') return res
  // Drop it only if nobody renewed it meanwhile.
  if (held.get(creds.secret)?.header === header) held.delete(creds.secret)
  return send(await authorization(creds))
}

/** The server wants a one-time code as well; ask for it and log in again. */
export class TotpRequired extends Error {
  constructor() {
    super('TOTP code required')
    this.name = 'TotpRequired'
  }
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(new Uint8Array(digest)) }
}

async function tokenEndpointOf(origin: string): Promise<string> {
  try {
    const res = await fetch(`${origin}/.well-known/oauth-authorization-server`)
    const meta = (await res.json()) as { token_endpoint?: unknown }
    if (res.ok && typeof meta.token_endpoint === 'string') return meta.token_endpoint
  } catch {
    /* fall through to Stalwart's path */
  }
  return `${origin}/auth/token`
}

/**
 * Logs in with a password (and TOTP code) for a refresh token.
 *
 * Answers null where the server has no such login, or it did not produce a
 * refresh token — the caller then uses Basic auth as before. Throws
 * `TotpRequired` when the account needs a code, and an `auth` `JmapError` when
 * the server turned the password (or code) down.
 */
export async function tokenLogin(params: {
  sessionUrl: string
  username: string
  password: string
  totp?: string
}): Promise<Credentials | null> {
  const origin = new URL(params.sessionUrl).origin
  const redirectUri = `${globalThis.location?.origin ?? origin}/`
  const { verifier, challenge } = await pkce()

  let login: { type?: string; client_code?: string }
  try {
    const res = await fetch(`${origin}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'authCode',
        accountName: params.username,
        accountSecret: params.password,
        ...(params.totp ? { mfaToken: params.totp } : {}),
        clientId: CLIENT_ID,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      }),
    })
    if (!res.ok) return null
    login = (await res.json()) as typeof login
  } catch {
    // Unreachable, blocked by CORS, or not JSON: not a server with this login.
    return null
  }
  if (login.type === 'mfaRequired') throw new TotpRequired()
  if (login.type === 'failure') throw new JmapError(t('login.failed'), 'auth', undefined, 401)
  if (login.type !== 'authenticated' || !login.client_code) return null

  const tokenEndpoint = await tokenEndpointOf(origin)
  let answer: TokenAnswer
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: login.client_code,
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })
    answer = (await res.json()) as TokenAnswer
    if (!res.ok) return null
  } catch {
    return null
  }
  if (!answer.access_token || !answer.refresh_token) return null
  hold(answer.refresh_token, answer)
  return {
    method: 'oauth',
    username: params.username,
    secret: answer.refresh_token,
    tokenEndpoint,
    clientId: CLIENT_ID,
  }
}

/** Test seam: forget every held access token. */
export function forgetAccessTokens(): void {
  held.clear()
  renewing.clear()
}
