import type { AccountCapabilities, Credentials } from '../../../domain/account'
import { t } from '../../../lib/i18n'
import { JmapError, authHeader } from './transport'
import { Cap, type CoreCapability, type JmapSession } from './types/core'

/**
 * Resolve an explicit server value (a full session URL, or a bare host) to a
 * session URL. Email addresses go through discoveryCandidates instead.
 */
export function sessionUrlFor(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed.includes('/jmap') || trimmed.includes('/.well-known')
      ? trimmed
      : `${trimmed.replace(/\/$/, '')}/.well-known/jmap`
  }
  return `https://${trimmed}/.well-known/jmap`
}

/** Local dev servers speak plain HTTP and live on a port. */
function isLocal(domain: string): boolean {
  return domain === 'localhost' || domain.endsWith('.localhost') || domain === '127.0.0.1'
}

/**
 * Ordered guesses for the session URL of an email address.
 *
 * RFC 8620 says to resolve the `_jmap._tcp` SRV record, but a browser has no
 * DNS API and this app has no backend, so we probe the conventional hosts
 * instead. `mail.` comes first because it is by far the most common, and
 * because the apex often has no A record at all on mail-only domains.
 * srvCandidates() covers what this misses, but only when the user asks for it.
 */
export function discoveryCandidates(email: string): string[] {
  const domain = email.trim().split('@')[1]?.trim().toLowerCase()
  if (!domain) return []
  if (isLocal(domain)) {
    // The dev Stalwart; https and the bare host are hopeless here.
    return [
      'http://localhost:8080/.well-known/jmap',
      `http://${domain}/.well-known/jmap`,
    ]
  }
  return [
    `https://mail.${domain}/.well-known/jmap`,
    `https://${domain}/.well-known/jmap`,
    `https://jmap.${domain}/.well-known/jmap`,
    `https://imap.${domain}/.well-known/jmap`,
  ]
}

interface DohAnswer {
  type: number
  data: string
}

/**
 * Resolve the `_jmap._tcp` SRV record over DNS-over-HTTPS.
 *
 * This is the spec's discovery mechanism and the only way to reach servers
 * whose hostname isn't guessable — but it hands the mail domain to a third
 * party, so it is never called on its own: the UI offers it only after every
 * guess in discoveryCandidates() has failed, and only on an explicit click.
 */
export async function srvCandidates(email: string, resolver = DOH_RESOLVER): Promise<string[]> {
  const domain = email.trim().split('@')[1]?.trim().toLowerCase()
  if (!domain || isLocal(domain)) return []
  const url = `${resolver}?name=${encodeURIComponent(`_jmap._tcp.${domain}`)}&type=SRV`
  let body: { Answer?: DohAnswer[] }
  try {
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } })
    if (!res.ok) throw new JmapError(`HTTP ${res.status}`, 'network')
    body = (await res.json()) as { Answer?: DohAnswer[] }
  } catch (e) {
    throw new JmapError(e instanceof Error ? e.message : 'DNS lookup failed', 'network')
  }
  const out: string[] = []
  for (const answer of body.Answer ?? []) {
    if (answer.type !== SRV_TYPE) continue
    // "priority weight port target." — target carries a trailing dot.
    const [, , port, target] = answer.data.trim().split(/\s+/)
    if (!target || !port) continue
    const host = target.replace(/\.$/, '')
    if (!host || host === '.') continue
    out.push(
      port === '443'
        ? `https://${host}/.well-known/jmap`
        : `https://${host}:${port}/.well-known/jmap`,
    )
  }
  return out
}

const DOH_RESOLVER = 'https://cloudflare-dns.com/dns-query'
const SRV_TYPE = 33

export interface ResolvedSession {
  session: JmapSession
  /** Session URL after following the well-known redirect. */
  sessionUrl: string
  /** Absolute URLs resolved against the session URL. */
  apiUrl: string
  downloadUrl: string
  uploadUrl: string
  eventSourceUrl: string
}

export async function fetchSession(
  sessionUrl: string,
  creds: Credentials,
): Promise<ResolvedSession> {
  let res: Response
  try {
    res = await fetch(sessionUrl, { headers: { Authorization: authHeader(creds) } })
  } catch (e) {
    throw new JmapError(e instanceof Error ? e.message : 'network error', 'network')
  }
  if (res.status === 401 || res.status === 403)
    throw new JmapError(t('login.failed'), 'auth', undefined, res.status)
  if (!res.ok) throw new JmapError(`HTTP ${res.status}`, 'protocol', undefined, res.status)
  const session = (await res.json()) as JmapSession
  const base = res.url || sessionUrl
  // new URL() percent-encodes the {placeholders} of RFC 6570 URL templates
  // in the path — restore them so template substitution keeps working.
  const abs = (u: string) => new URL(u, base).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
  return {
    session,
    sessionUrl: base,
    apiUrl: abs(session.apiUrl),
    downloadUrl: abs(session.downloadUrl),
    uploadUrl: abs(session.uploadUrl),
    eventSourceUrl: abs(session.eventSourceUrl),
  }
}

export function coreLimits(session: JmapSession): CoreCapability {
  const core = session.capabilities[Cap.core] as CoreCapability | undefined
  return (
    core ?? {
      maxSizeUpload: 50_000_000,
      maxConcurrentUpload: 2,
      maxSizeRequest: 10_000_000,
      maxConcurrentRequests: 2,
      maxCallsInRequest: 16,
      maxObjectsInGet: 500,
      maxObjectsInSet: 500,
    }
  )
}

/** Map JMAP account capabilities to the provider-agnostic feature flags. */
export function capabilitiesFor(
  session: JmapSession,
  remoteAccountId: string,
): AccountCapabilities {
  const acc = session.accounts[remoteAccountId]
  const has = (urn: string) => acc != null && urn in acc.accountCapabilities
  return {
    mail: has(Cap.mail),
    submission: has(Cap.submission),
    contacts: has(Cap.contacts),
    calendars: has(Cap.calendars),
    sieve: has(Cap.sieve),
    vacation: has(Cap.vacation),
    push: session.eventSourceUrl ? 'sse' : 'poll',
    webPush: Cap.webpushVapid in session.capabilities,
  }
}

/** Primary mail account id within the session, if any. */
export function primaryMailAccount(session: JmapSession): string | null {
  return (
    session.primaryAccounts?.[Cap.mail] ??
    Object.keys(session.accounts).find((id) =>
      Object.keys(session.accounts[id]?.accountCapabilities ?? {}).includes(Cap.mail),
    ) ??
    null
  )
}
