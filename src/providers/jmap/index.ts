import type { Account, Credentials } from '../../domain/account'
import { t } from '../../lib/i18n'
import type { Provider, ProviderConnection } from '../types'
import { createTransport } from './client/transport'
import { capabilitiesFor, coreLimits, fetchSession, mailAccounts } from './client/session'
import { createJmapCalendars } from './calendars'
import { createJmapContacts } from './contacts'
import { createJmapFiles } from './files'
import { createJmapSieve } from './sieve'
import { createJmapMail } from './mail'
import { createJmapQuota } from './quota'

/**
 * One account of an opened session. Nothing is fetched: the transport, the
 * limits and the credentials are the session's.
 */
function accountConnection(
  resolved: Awaited<ReturnType<typeof fetchSession>>,
  creds: Credentials,
  sessionId: string,
  localId: string,
  remoteAccountId: string,
  transport: ReturnType<typeof createTransport>,
): ProviderConnection {
  const capabilities = capabilitiesFor(resolved.session, remoteAccountId)
  const limits = coreLimits(resolved.session)
  const account: Account = {
    id: localId,
    sessionId,
    provider: 'jmap',
    // The account's own name: several behind one login would otherwise all
    // carry the login's.
    label:
      resolved.session.accounts[remoteAccountId]?.name ||
      resolved.session.username ||
      creds.username ||
      remoteAccountId,
    remoteAccountId,
    sessionUrl: resolved.sessionUrl,
    capabilities,
    encrypted: false,
  }
  return {
    account,
    capabilities,
    mail: capabilities.mail
      ? createJmapMail(transport, remoteAccountId, limits, resolved.uploadUrl, resolved.downloadUrl)
      : null,
    contacts: capabilities.contacts ? createJmapContacts(transport, remoteAccountId) : null,
    calendars: capabilities.calendars ? createJmapCalendars(transport, remoteAccountId) : null,
    files: capabilities.files
      ? createJmapFiles(transport, remoteAccountId, resolved.uploadUrl, resolved.downloadUrl)
      : null,
    sieve: capabilities.sieve
      ? createJmapSieve(transport, remoteAccountId, resolved.uploadUrl, resolved.downloadUrl)
      : null,
    quota: capabilities.quota ? createJmapQuota(transport, remoteAccountId) : null,
    push: {
      eventSourceUrl: resolved.eventSourceUrl,
      credentials: creds,
    },
  }
}

export const jmapProvider: Provider = {
  kind: 'jmap',
  async openSession(sessionUrl, creds, sessionId) {
    const resolved = await fetchSession(sessionUrl, creds)
    const accounts = mailAccounts(resolved.session)
    if (!accounts.length) throw new Error(t('login.noMailAccount'))
    const transport = createTransport(resolved.apiUrl, creds)
    return {
      session: {
        id: sessionId,
        provider: 'jmap',
        sessionUrl: resolved.sessionUrl,
        label: resolved.session.username || creds.username || accounts[0]!,
      },
      credentials: creds,
      accounts,
      account(forSession, localId, remoteAccountId) {
        if (!accounts.includes(remoteAccountId)) throw new Error(t('login.accountGone'))
        return accountConnection(resolved, creds, forSession, localId, remoteAccountId, transport)
      },
    }
  },
}
