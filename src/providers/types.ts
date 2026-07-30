import type { Account, AccountCapabilities, Credentials } from '../domain/account'
import type { EmailBody, EmailHeader } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'

/**
 * The portability contract: UI and sync engine depend only on these interfaces
 * and on src/domain types. providers/jmap implements them; future IMAP/Gmail
 * providers implement the same shapes and report their own capabilities.
 */

export interface SyncPage<T> {
  created: T[]
  updated: T[]
  destroyedIds: string[]
  newState: string
  hasMore: boolean
}

export class CannotCalculateChanges extends Error {
  constructor() {
    super('cannotCalculateChanges')
  }
}

export interface MailProvider {
  /** Full fetch when state is undefined, otherwise delta via changes. */
  syncMailboxes(sinceState?: string): Promise<SyncPage<Mailbox>>
  /** Throws CannotCalculateChanges when the server lost the state. */
  syncEmailHeaders(sinceState: string): Promise<SyncPage<EmailHeader>>
  /** Paged full fetch of all email headers (initial sync / recovery). */
  listAllEmailHeaders(
    onPage: (page: { headers: EmailHeader[]; state: string }) => Promise<void>,
  ): Promise<string>
  getEmailHeaders(ids: string[]): Promise<EmailHeader[]>
  getEmailBody(id: string): Promise<EmailBody | null>
}

export interface ProviderConnection {
  account: Account
  capabilities: AccountCapabilities
  mail: MailProvider | null
}

export interface Provider {
  kind: Account['provider']
  /** Validate credentials against a server and derive the account object. */
  connect(server: string, creds: Credentials, localId: string): Promise<ProviderConnection>
  /** Re-open a connection for a stored account. */
  open(account: Account, creds: Credentials): Promise<ProviderConnection>
}
