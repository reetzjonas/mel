import type { Account, Credentials } from '../../domain/account'
import { t } from '../../lib/i18n'
import type { Provider, ProviderConnection } from '../types'
import { createTransport } from './client/transport'
import {
  capabilitiesFor,
  coreLimits,
  fetchSession,
  primaryMailAccount,
  sessionUrlFor,
} from './client/session'
import { createJmapMail } from './mail'

async function buildConnection(
  sessionUrl: string,
  creds: Credentials,
  localId: string,
): Promise<ProviderConnection> {
  const resolved = await fetchSession(sessionUrl, creds)
  const remoteAccountId = primaryMailAccount(resolved.session)
  if (!remoteAccountId) throw new Error(t('login.noMailAccount'))
  const capabilities = capabilitiesFor(resolved.session, remoteAccountId)
  const transport = createTransport(resolved.apiUrl, creds)
  const limits = coreLimits(resolved.session)
  const account: Account = {
    id: localId,
    provider: 'jmap',
    label: resolved.session.username || creds.username || remoteAccountId,
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
    push: {
      eventSourceUrl: resolved.eventSourceUrl,
      credentials: creds,
    },
  }
}

export const jmapProvider: Provider = {
  kind: 'jmap',
  connect(server, creds, localId) {
    return buildConnection(sessionUrlFor(server), creds, localId)
  },
  open(account, creds) {
    return buildConnection(account.sessionUrl, creds, account.id)
  },
}
