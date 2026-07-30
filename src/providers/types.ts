import type { Account, AccountCapabilities, Credentials } from '../domain/account'
import type { EmailBody, EmailHeader } from '../domain/email'
import type { Identity, OutgoingEmail } from '../domain/identity'
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

export interface SetFailure {
  type: string
  description?: string
  /** Permanent failures are surfaced to the user instead of retried. */
  permanent: boolean
}

export interface SetOutcome {
  updated: string[]
  destroyed: string[]
  failed: Record<string, SetFailure>
}

export interface MailboxEdit {
  create?: { name: string; parentId: string | null; role?: string }
  update?: { id: string; name?: string; parentId?: string | null }
  destroy?: string
}

export interface QueryOptions {
  limit?: number
  /** Restrict to one mailbox; omit for account-wide search. */
  mailboxId?: string
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

  /** JSON-patch style updates ({"keywords/$seen": true}) and destroys. */
  setEmails(updates: Record<string, Record<string, unknown>>, destroy: string[]): Promise<SetOutcome>
  editMailbox(edit: MailboxEdit): Promise<{ id: string | null; failure: SetFailure | null }>
  identities(): Promise<Identity[]>
  uploadBlob(data: Blob | ArrayBuffer, type: string): Promise<{ blobId: string; size: number }>
  /** Create the message and submit it in one request (moves it to Sent). */
  sendEmail(mail: OutgoingEmail, mailboxIds: { drafts: string; sent: string }): Promise<void>
  /** Server-side search; returns ids in relevance/date order plus snippets. */
  searchEmails(
    filter: import('../domain/search').SearchQuery,
    opts: QueryOptions,
  ): Promise<{ ids: string[]; snippets: Record<string, { subject: string | null; preview: string | null }> }>
  getVacation(): Promise<VacationSettings>
  setVacation(v: VacationSettings): Promise<void>
  downloadBlob(blobId: string, type: string, name: string): Promise<Blob>
}

export interface VacationSettings {
  enabled: boolean
  subject: string
  text: string
}

export interface PushInfo {
  eventSourceUrl: string
  credentials: Credentials
}

export interface ProviderConnection {
  account: Account
  capabilities: AccountCapabilities
  mail: MailProvider | null
  push: PushInfo | null
}

export interface Provider {
  kind: Account['provider']
  /** Validate credentials against a server and derive the account object. */
  connect(server: string, creds: Credentials, localId: string): Promise<ProviderConnection>
  /** Re-open a connection for a stored account. */
  open(account: Account, creds: Credentials): Promise<ProviderConnection>
}
