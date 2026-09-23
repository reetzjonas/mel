import type { Account, AccountCapabilities, Credentials } from '../domain/account'
import type { AddressBook, Contact } from '../domain/contact'
import type { EmailBody, EmailHeader, MailFilter } from '../domain/email'
import type { MessageMetadata } from '../domain/messageMetadata'
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
  /**
   * JMAP onDestroyRemoveEmails. Without it a mailbox holding mail is refused
   * with mailboxHasEmail. Note it does not delete the mail outright: each
   * message merely loses this mailbox, and only messages that were *nowhere
   * else* cease to exist.
   */
  destroyWithEmails?: boolean
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
  /**
   * Paged full fetch of all email headers (initial sync / recovery).
   *
   * `total` is what the server says the account holds, so a first login on a
   * large mailbox can say how far along it is instead of showing an empty
   * list; null when the server declines to count.
   */
  listAllEmailHeaders(
    onPage: (page: {
      headers: EmailHeader[]
      state: string
      total: number | null
    }) => Promise<void>,
  ): Promise<string>
  getEmailHeaders(ids: string[]): Promise<EmailHeader[]>
  getEmailBody(id: string): Promise<EmailBody | null>
  /** Raw headers plus the blob id of the whole message, fetched on demand. */
  getEmailMetadata(id: string): Promise<MessageMetadata | null>

  /** JSON-patch style updates ({"keywords/$seen": true}) and destroys. */
  setEmails(
    updates: Record<string, Record<string, unknown>>,
    destroy: string[],
  ): Promise<SetOutcome>
  /** Ids in a mailbox, newest first, plus the server's total for that mailbox. */
  queryMailboxIds(
    mailboxId: string,
    limit: number,
    view?: MailFilter,
  ): Promise<{ ids: string[]; total: number }>
  editMailbox(edit: MailboxEdit): Promise<{ id: string | null; failure: SetFailure | null }>
  identities(): Promise<Identity[]>
  uploadBlob(data: Blob | ArrayBuffer, type: string): Promise<{ blobId: string; size: number }>
  /** Create the message and submit it in one request (moves it to Sent). */
  sendEmail(mail: OutgoingEmail, mailboxIds: { drafts: string; sent: string }): Promise<void>
  /**
   * Send a message mel wrote itself as raw RFC 5322 (OpenPGP mail, whose bytes
   * the server must not rebuild). Same Drafts-then-Sent path as sendEmail.
   */
  sendRawEmail(
    raw: string,
    envelope: { mailFrom: string; rcptTo: string[] },
    identityId: string,
    mailboxIds: { drafts: string; sent: string },
  ): Promise<void>
  /**
   * What became of messages sent since `after` (an ISO date), newest first;
   * null when the server cannot say.
   */
  recentSubmissions(after: string): Promise<import('../domain/submission').Submission[] | null>
  /** Persist a draft (replacing a previous autosave); returns the new draft id. */
  saveDraft(
    mail: OutgoingEmail,
    draftsMailboxId: string,
    replaceId: string | null,
  ): Promise<string | null>
  /** Server-side search; returns ids in relevance/date order plus snippets. */
  searchEmails(
    filter: import('../domain/search').SearchQuery,
    opts: QueryOptions,
  ): Promise<{
    ids: string[]
    snippets: Record<string, { subject: string | null; preview: string | null }>
  }>
  getVacation(): Promise<VacationSettings>
  setVacation(v: VacationSettings): Promise<void>
  downloadBlob(blobId: string, type: string, name: string): Promise<Blob>
}

export interface VacationSettings {
  enabled: boolean
  subject: string
  text: string
}

/** One change to the calendar list: exactly one of `create`, `update`, `destroy`. */
export interface CalendarEdit {
  create?: { name: string; color: string | null }
  update?: { id: string; name?: string; color?: string | null }
  destroy?: string
  /** Remove the calendar's events along with it; without this a non-empty one is refused. */
  destroyWithEvents?: boolean
}

export interface CalendarProvider {
  syncCalendars(sinceState?: string): Promise<SyncPage<import('../domain/calendar').Calendar>>
  syncEvents(sinceState?: string): Promise<SyncPage<import('../domain/calendar').CalendarEvent>>
  createEvent(
    event: import('../domain/calendar').CalendarEvent,
  ): Promise<{ id: string | null; failure: SetFailure | null }>
  updateEvent(event: import('../domain/calendar').CalendarEvent): Promise<SetFailure | null>
  /** Answer an invitation and let the server notify the organizer. */
  rsvp(
    eventId: string,
    participantId: string,
    status: import('../domain/calendar').ParticipationStatus,
  ): Promise<SetFailure | null>
  destroyEvents(ids: string[]): Promise<SetFailure | null>
  /** Other people's changes to events we are part of, newest state first as the server keeps it. */
  syncEventNotifications(
    sinceState?: string,
  ): Promise<SyncPage<import('../domain/calendar').EventNotification>>
  /** Dismiss notifications — they are gone from the server for every client. */
  dismissEventNotifications(ids: string[]): Promise<SetFailure | null>
  editCalendar(edit: CalendarEdit): Promise<{ id: string | null; failure: SetFailure | null }>
}

export interface ContactsProvider {
  syncAddressBooks(sinceState?: string): Promise<SyncPage<AddressBook>>
  syncContacts(sinceState?: string): Promise<SyncPage<Contact>>
  createContact(contact: Contact): Promise<{ id: string | null; failure: SetFailure | null }>
  updateContact(contact: Contact): Promise<SetFailure | null>
  destroyContacts(ids: string[]): Promise<SetFailure | null>
}

export interface NewFile {
  name: string
  /** null creates at the top level of the account. */
  parentId: string | null
  data: Blob | ArrayBuffer
  type: string
}

/** Rename (`name`) and/or move (`parentId`). */
export interface NodeEdit {
  name?: string
  parentId?: string | null
  executable?: boolean
}

/**
 * File storage, where the server offers it (JMAP FileNode).
 *
 * Writes are server-first and have no outbox action: there is no local mirror
 * of the tree to write optimistically into, and the only caller so far wants
 * to know whether the write landed before it does anything else.
 */
export interface FilesProvider {
  /** Full fetch when state is undefined, otherwise delta via changes. */
  syncNodes(sinceState?: string): Promise<SyncPage<import('../domain/file').FileNode>>
  /** Direct children of a directory; null lists the top level. */
  listChildren(parentId: string | null): Promise<import('../domain/file').FileNode[]>
  createDirectory(
    name: string,
    parentId: string | null,
  ): Promise<{ id: string | null; failure: SetFailure | null }>
  /** Uploads the content, then creates the node pointing at it. */
  createFile(file: NewFile): Promise<{ id: string | null; failure: SetFailure | null }>
  /** Replace the content of an existing file. */
  writeFileContent(id: string, data: Blob | ArrayBuffer, type: string): Promise<SetFailure | null>
  editNode(id: string, edit: NodeEdit): Promise<SetFailure | null>
  /** Not recursive: a parent and its child in one call fails both. */
  destroyNodes(ids: string[]): Promise<SetFailure | null>
  /** null for a node that has no content (a directory). */
  readFile(node: import('../domain/file').FileNode): Promise<Blob | null>
  /** Content by blob id — for a link that outlived the node it was made from. */
  readBlob(blobId: string, type: string, name: string): Promise<Blob>
  /** The URL the node's content is served from, or null for a directory. */
  downloadHref(node: import('../domain/file').FileNode): string | null
}

export interface SieveScriptEdit {
  /** Omitted to create a new script. */
  id?: string
  name: string
  content: string
  /** Make it the one script that runs, once the write succeeds. */
  activate?: boolean
}

/**
 * Server-side mail filtering (RFC 9661).
 *
 * Server-first like files and for the same reason: the script text has to
 * reach the server to mean anything, and the server is also the only thing
 * that can say whether it parses.
 */
export interface SieveProvider {
  listScripts(): Promise<import('../domain/sieve').SieveScript[]>
  /** The script text, fetched on demand. */
  readScript(script: import('../domain/sieve').SieveScript): Promise<string>
  /** null when it parses; otherwise the server's message, naming the line. */
  validate(content: string): Promise<string | null>
  saveScript(edit: SieveScriptEdit): Promise<{ id: string | null; failure: SetFailure | null }>
  /** null switches filtering off rather than choosing another script. */
  setActive(id: string | null): Promise<SetFailure | null>
  destroyScript(id: string): Promise<SetFailure | null>
}

export interface QuotaProvider {
  /** null when the server tracks no limit for this account. */
  storage(): Promise<import('../domain/quota').StorageQuota | null>
}

export interface PushInfo {
  eventSourceUrl: string
  credentials: Credentials
}

export interface ProviderConnection {
  account: Account
  capabilities: AccountCapabilities
  mail: MailProvider | null
  contacts: ContactsProvider | null
  calendars: CalendarProvider | null
  files: FilesProvider | null
  sieve: SieveProvider | null
  quota: QuotaProvider | null
  push: PushInfo | null
}

export interface Provider {
  kind: Account['provider']
  /** Validate credentials against a server and derive the account object. */
  connect(server: string, creds: Credentials, localId: string): Promise<ProviderConnection>
  /** Re-open a connection for a stored account. */
  open(account: Account, creds: Credentials): Promise<ProviderConnection>
}
