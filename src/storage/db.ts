import Dexie, { type Table } from 'dexie'
import type { Account, Credentials } from '../domain/account'
import type { Calendar, CalendarEvent } from '../domain/calendar'
import type { AddressBook, Contact } from '../domain/contact'
import type { EmailBody, EmailHeader, Thread } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'
import { cryptoMiddleware } from './crypto/middleware'
import type { Envelope } from './envelope'

// Rows carry plaintext index columns (ids, timestamps, flags only) plus the
// payload envelope holding everything human-readable. See envelope.ts.

export interface AccountRow {
  id: string
  provider: string
  encrypted: boolean
  payload: Envelope<{ account: Account; credentials: Credentials }>
}

export interface SyncStateRow {
  accountId: string
  collection: string // 'Mailbox' | 'Email' | 'Thread' | 'ContactCard' | ...
  state: string
  updatedAt: number
}

export interface MailboxRow {
  accountId: string
  id: string
  parentId: string | null
  role: string | null
  sortOrder: number
  payload: Envelope<Mailbox>
}

export interface EmailRow {
  accountId: string
  id: string
  threadId: string
  /** Plain array mirror of mailboxIds for the multiEntry index. */
  mailboxIds: string[]
  receivedAt: number // epoch ms, for sorting
  unread: 0 | 1
  flagged: 0 | 1
  payload: Envelope<EmailHeader>
}

export interface ThreadRow {
  accountId: string
  id: string
  latestAt: number
  payload: Envelope<Thread>
}

export interface BodyCacheRow {
  accountId: string
  emailId: string
  lastAccess: number
  payload: Envelope<EmailBody>
}

export interface BlobCacheRow {
  accountId: string
  blobId: string
  size: number
  lastAccess: number
  payload: Envelope<{ type: string; data: ArrayBuffer }>
}

export interface OutboxRow {
  seq?: number
  accountId: string
  kind: string
  status: 'pending' | 'inflight' | 'failed'
  attempts: number
  notBefore: number
  payload: Envelope<unknown>
}

export interface AddressBookRow {
  accountId: string
  id: string
  payload: Envelope<AddressBook>
}

export interface ContactRow {
  accountId: string
  id: string
  addressBookIds: string[]
  /** Lowercased sort key (surname/name/email). Plaintext-safe: needed for ordering. */
  sortKey: string
  payload: Envelope<Contact>
}

export interface CalendarRow {
  accountId: string
  id: string
  payload: Envelope<Calendar>
}

export interface EventRow {
  accountId: string
  id: string
  calendarIds: string[]
  payload: Envelope<CalendarEvent>
}

export interface KeyringRow {
  accountId: string
  kdf: { algo: 'argon2id' | 'pbkdf2'; salt: Uint8Array; params: Record<string, number> }
  wrappedDek: Uint8Array
  /** AES-GCM encryption of a known constant — wrong-passphrase detection. */
  verifier: Uint8Array
}

export type AccountScopedKey = [string, string]

export class MelDb extends Dexie {
  accounts!: Table<AccountRow, string>
  syncState!: Table<SyncStateRow, AccountScopedKey>
  mailboxes!: Table<MailboxRow, AccountScopedKey>
  emails!: Table<EmailRow, AccountScopedKey>
  threads!: Table<ThreadRow, AccountScopedKey>
  bodyCache!: Table<BodyCacheRow, AccountScopedKey>
  blobCache!: Table<BlobCacheRow, AccountScopedKey>
  outbox!: Table<OutboxRow, number>
  keyring!: Table<KeyringRow, string>
  addressBooks!: Table<AddressBookRow, AccountScopedKey>
  contacts!: Table<ContactRow, AccountScopedKey>
  calendars!: Table<CalendarRow, AccountScopedKey>
  events!: Table<EventRow, AccountScopedKey>

  constructor() {
    super('mel')
    this.version(1).stores({
      accounts: '&id',
      syncState: '&[accountId+collection]',
      mailboxes: '&[accountId+id], accountId, [accountId+parentId], [accountId+role]',
      emails:
        '&[accountId+id], [accountId+threadId], [accountId+receivedAt], *mailboxIds, [accountId+unread], [accountId+flagged]',
      threads: '&[accountId+id], [accountId+latestAt]',
      bodyCache: '&[accountId+emailId], lastAccess',
      blobCache: '&[accountId+blobId], lastAccess',
      outbox: '++seq, accountId, status, notBefore',
      keyring: '&accountId',
    })
    this.version(2).stores({
      addressBooks: '&[accountId+id], accountId',
      contacts: '&[accountId+id], accountId, *addressBookIds, [accountId+sortKey]',
    })
    this.version(3).stores({
      calendars: '&[accountId+id], accountId',
      events: '&[accountId+id], accountId, *calendarIds',
    })
    this.use(cryptoMiddleware)
  }
}

export const db = new MelDb()
