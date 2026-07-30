import type { AccountCapabilities, Credentials } from '../../../domain/account'
import { t } from '../../../lib/i18n'
import { JmapError, authHeader } from './transport'
import { Cap, type CoreCapability, type JmapSession } from './types/core'

/**
 * Resolve a user-entered server value to a session URL.
 * Accepts a full session URL, a bare host, or an email address
 * (→ https://{domain}/.well-known/jmap autodiscovery).
 */
export function sessionUrlFor(input: string): string {
  const trimmed = input.trim()
  if (trimmed.includes('@')) {
    const domain = trimmed.split('@')[1]
    return `https://${domain}/.well-known/jmap`
  }
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed.includes('/jmap') || trimmed.includes('/.well-known')
      ? trimmed
      : `${trimmed.replace(/\/$/, '')}/.well-known/jmap`
  }
  return `https://${trimmed}/.well-known/jmap`
}

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
