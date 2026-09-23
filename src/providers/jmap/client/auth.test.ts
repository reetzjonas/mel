import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Credentials } from '../../../domain/account'
import {
  TotpRequired,
  authorization,
  authorizedFetch,
  forgetAccessTokens,
  onRefreshTokenRotated,
  tokenLogin,
} from './auth'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch that answers by URL, and records what it was asked. */
function serve(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!route) throw new TypeError('Failed to fetch')
    return routes[route]!(init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

const oauth = (): Credentials => ({
  method: 'oauth',
  username: 'alice@example.test',
  secret: 'refresh-1',
  tokenEndpoint: 'https://mail.example.test/auth/token',
  clientId: 'mel',
})

const form = (init: RequestInit) => new URLSearchParams(String(init.body))

beforeEach(() => forgetAccessTokens())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  onRefreshTokenRotated(null)
})

describe('a refresh token as credentials', () => {
  it('buys an access token once and reuses it until shortly before it expires', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    let n = 0
    const calls = serve({
      'https://mail.example.test/auth/token': () =>
        json({ access_token: `access-${++n}`, expires_in: 3600 }),
    })
    const creds = oauth()

    await expect(authorization(creds)).resolves.toBe('Bearer access-1')
    await expect(authorization(creds)).resolves.toBe('Bearer access-1')
    expect(calls).toHaveLength(1)
    expect(Object.fromEntries(form(calls[0]!.init))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'mel',
    })

    // A minute before the hour: renewed early rather than sent and refused.
    vi.setSystemTime(3600_000 - 59_000)
    await expect(authorization(creds)).resolves.toBe('Bearer access-2')
  })

  it('renews once for everything that asks at the same time', async () => {
    // The sync, the event stream and a download all start together on launch.
    const calls = serve({
      'https://mail.example.test/auth/token': () => json({ access_token: 'a', expires_in: 3600 }),
    })
    const creds = oauth()
    await Promise.all([authorization(creds), authorization(creds), authorization(creds)])
    expect(calls).toHaveLength(1)
  })

  it('renews and retries once when a request is refused anyway', async () => {
    // Revoked on the server, or this device's clock is off: the held token is
    // not as good as its expiry said.
    let n = 0
    let api = 0
    const calls = serve({
      'https://mail.example.test/auth/token': () =>
        json({ access_token: `access-${++n}`, expires_in: 3600 }),
      'https://mail.example.test/jmap/': () =>
        new Response('', { status: ++api === 1 ? 401 : 200 }),
    })

    const res = await authorizedFetch(oauth(), 'https://mail.example.test/jmap/')

    expect(res.status).toBe(200)
    const sent = calls.filter((c) => c.url.endsWith('/jmap/'))
    expect(sent.map((c) => new Headers(c.init.headers).get('Authorization'))).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ])
  })

  it('leaves a refused password to the caller: nothing to renew', async () => {
    const calls = serve({
      'https://mail.example.test/jmap/': () => new Response('', { status: 401 }),
    })
    const res = await authorizedFetch(
      { method: 'basic', username: 'a', secret: 'b' },
      'https://mail.example.test/jmap/',
    )
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('calls a refused refresh token a sign-in problem, and an outage an outage', async () => {
    // Only the first asks the user to sign in again; the second is retried.
    serve({ 'https://mail.example.test/auth/token': () => json({ error: 'invalid_grant' }, 400) })
    await expect(authorization(oauth())).rejects.toMatchObject({ kind: 'auth' })

    serve({ 'https://mail.example.test/auth/token': () => new Response('', { status: 503 }) })
    await expect(authorization(oauth())).rejects.toMatchObject({ kind: 'server' })

    serve({})
    await expect(authorization(oauth())).rejects.toMatchObject({ kind: 'network' })
  })

  it('takes over a new refresh token handed out with a renewal', async () => {
    serve({
      'https://mail.example.test/auth/token': () =>
        json({ access_token: 'a', expires_in: 3600, refresh_token: 'refresh-2' }),
    })
    const rotated = vi.fn()
    onRefreshTokenRotated(rotated)
    const creds = oauth()

    await authorization(creds)

    expect(creds.secret).toBe('refresh-2')
    expect(rotated).toHaveBeenCalledWith('refresh-1', creds)
  })
})

describe('logging in with a password for a token', () => {
  const base = 'https://mail.example.test'
  const params = {
    sessionUrl: `${base}/.well-known/jmap`,
    username: 'alice@example.test',
    password: 'pw',
  }

  it('trades the password for a refresh token, with PKCE', async () => {
    const calls = serve({
      [`${base}/api/auth`]: () => json({ type: 'authenticated', client_code: 'code-1' }),
      [`${base}/.well-known/oauth-authorization-server`]: () =>
        json({ token_endpoint: `${base}/auth/token` }),
      [`${base}/auth/token`]: () =>
        json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1' }),
    })

    const creds = await tokenLogin({ ...params, totp: '123456' })

    expect(creds).toEqual({
      method: 'oauth',
      username: 'alice@example.test',
      secret: 'refresh-1',
      tokenEndpoint: `${base}/auth/token`,
      clientId: 'mel',
    })
    const login = JSON.parse(String(calls[0]!.init.body)) as Record<string, string>
    expect(login).toMatchObject({
      type: 'authCode',
      accountName: 'alice@example.test',
      accountSecret: 'pw',
      mfaToken: '123456',
      clientId: 'mel',
      codeChallengeMethod: 'S256',
    })
    const exchange = form(calls[2]!.init)
    expect(exchange.get('code')).toBe('code-1')
    expect(exchange.get('redirect_uri')).toBe(login['redirectUri'])
    // The verifier is what the challenge was made from.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(exchange.get('code_verifier')!),
    )
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(login['codeChallenge']).toBe(challenge)

    // The access token that came with it is used straight away.
    await expect(authorization(creds!)).resolves.toBe('Bearer access-1')
    expect(calls).toHaveLength(3)
  })

  it('asks for a code when the account has one', async () => {
    serve({ [`${base}/api/auth`]: () => json({ type: 'mfaRequired' }) })
    await expect(tokenLogin(params)).rejects.toBeInstanceOf(TotpRequired)
  })

  it('reports a refused password as a sign-in failure', async () => {
    serve({ [`${base}/api/auth`]: () => json({ type: 'failure' }) })
    await expect(tokenLogin(params)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('answers null where the server has no such login, so Basic is used', async () => {
    serve({ [`${base}/api/auth`]: () => new Response('', { status: 404 }) })
    await expect(tokenLogin(params)).resolves.toBeNull()

    // Blocked by CORS or not there at all looks the same from here.
    serve({})
    await expect(tokenLogin(params)).resolves.toBeNull()

    serve({ [`${base}/api/auth`]: () => new Response('<html>', { status: 200 }) })
    await expect(tokenLogin(params)).resolves.toBeNull()
  })

  it('falls back to Stalwart’s path when the server does not describe itself', async () => {
    const calls = serve({
      [`${base}/api/auth`]: () => json({ type: 'authenticated', client_code: 'c' }),
      [`${base}/auth/token`]: () =>
        json({ access_token: 'a', expires_in: 3600, refresh_token: 'r' }),
    })
    const creds = await tokenLogin(params)
    expect(creds?.tokenEndpoint).toBe(`${base}/auth/token`)
    expect(calls.map((c) => c.url)).toContain(`${base}/auth/token`)
  })

  it('falls back to Basic when the code cannot be exchanged', async () => {
    serve({
      [`${base}/api/auth`]: () => json({ type: 'authenticated', client_code: 'c' }),
      [`${base}/auth/token`]: () => json({ error: 'invalid_grant' }, 400),
    })
    await expect(tokenLogin(params)).resolves.toBeNull()
  })

  it('does not store what it cannot renew: no refresh token, no token login', async () => {
    serve({
      [`${base}/api/auth`]: () => json({ type: 'authenticated', client_code: 'c' }),
      [`${base}/auth/token`]: () => json({ access_token: 'a', expires_in: 3600 }),
    })
    await expect(tokenLogin(params)).resolves.toBeNull()
  })
})
