import Dexie, { type Table, type Transaction } from 'dexie'
import type { Account, Credentials } from '../domain/account'
import type { Calendar, CalendarEvent } from '../domain/calendar'
import type { AddressBook, Contact } from '../domain/contact'
import type { EmailBody, EmailHeader, Thread } from '../domain/email'
import type { FileNode } from '../domain/file'
import type { Mailbox } from '../domain/mailbox'
import type { Note } from '../domain/note'
import { cryptoMiddleware } from './crypto/middleware'
import { mailboxDateKey } from './emailRow'
import type { Envelope } from './envelope'

// Rows carry plaintext index columns (ids, timestamps, flags only) plus the
// payload envelope holding everything human-readable. See envelope.ts.

export interface AccountRow {
  id: string
  provider: string
  encrypted: boolean
  /**
   * Whether a push notification may name the sender and subject.
   *
   * A flag rather than payload, because the service worker is the only reader
   * that matters and it has no Dexie, no middleware and — for an encrypted
   * account — no key. Meaningful only while `encrypted` is false; enabling
   * encryption clears it (services/encryption.ts).
   */
  pushDetails?: boolean
  payload: Envelope<{ account: Account; credentials: Credentials }>
}

export interface SyncStateRow {
  accountId: string
  collection: string // 'Mailbox' | 'Email' | 'Thread' | 'ContactCard' | ...
  state: string
  /**
   * How much of each object the app kept when these rows were written
   * (sync/engine.ts). Absent on rows from before this existed, which counts
   * as 1. A cursor whose version is behind is not a cursor worth resuming:
   * delta sync would carry the gap forward for ever.
   */
  modelVersion?: number
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
  /** One `<mailboxId>+<inverted receivedAt>` per mailbox — see emailRow.ts. */
  mailboxDates: string[]
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
  /**
   * Why the last attempt failed, as a **protocol token** — `notFound`,
   * `forbidden`, `network 503`, never a server-written sentence. The full
   * error goes to the console; this column is read by the queue view, and it
   * sits outside the encrypted payload like every other index column, so it
   * must stay a classification rather than anything the message carried.
   */
  reason?: string
  /** When it was given up on, for the queue view. */
  failedAt?: number
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

export interface FileNodeRow {
  accountId: string
  id: string
  /**
   * The parent, with the empty string standing in for "top level".
   *
   * Not `string | null` like the domain object: IndexedDB skips a record whose
   * indexed key is null, so a nullable column would leave every root node out
   * of the very index the listing is built on. Opening a folder is the one
   * query this table exists to answer, so it gets a key that always indexes.
   */
  parentKey: string
  /** Folders sort before files, and that must not need the payload open. */
  nodeType: string
  payload: Envelope<FileNode>
}

export interface KeyringRow {
  accountId: string
  kdf: { algo: 'argon2id' | 'pbkdf2'; salt: Uint8Array; params: Record<string, number> }
  wrappedDek: Uint8Array
  /** AES-GCM encryption of a known constant — wrong-passphrase detection. */
  verifier: Uint8Array
}

/**
 * A note's decoded fields, mirrored from the Markdown file it lives in.
 *
 * The file is the record; this is the read model, so the list can be drawn and
 * searched without fetching a blob per note on every render. `modified` is the
 * file node's own timestamp and is what decides whether the blob has to be
 * read again at all.
 */
export interface NoteRow {
  accountId: string
  /** The note's folder id, or a local- id while it exists only here. */
  id: string
  /** Sorting, and nothing else, lives outside the envelope. */
  pinned: 0 | 1
  modified: string
  payload: Envelope<Note>
}

export type AccountScopedKey = [string, string]

export interface ImageSendersRow {
  accountId: string
  payload: Envelope<string[]>
}

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
  files!: Table<FileNodeRow, AccountScopedKey>
  notes!: Table<NoteRow, AccountScopedKey>
  imageSenders!: Table<ImageSendersRow, string>

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
    /*
     * The derived per-folder date index (emailRow.ts). Its backfill only ever
     * touches index columns, never the payload: `modify` hands over the stored
     * row as it is, and the crypto middleware leaves a sealed payload sealed
     * on the way back out — so it runs correctly whether the account is
     * encrypted, locked, or neither.
     */
    this.version(4)
      .stores({
        emails:
          '&[accountId+id], [accountId+threadId], [accountId+receivedAt], *mailboxIds, *mailboxDates, [accountId+unread], [accountId+flagged]',
      })
      .upgrade((tx) => backfillMailboxDates(tx))
    // Same column, now with the thread as a third segment so the grouped list
    // can read its window without scanning the account (see emailRow.ts).
    this.version(5).upgrade((tx) => backfillMailboxDates(tx))
    this.version(6).stores({
      files: '&[accountId+id], accountId, [accountId+parentKey]',
    })
    this.version(7).stores({
      notes: '&[accountId+id], accountId, [accountId+pinned]',
    })
    this.version(8).stores({ imageSenders: '&accountId' })
    this.use(cryptoMiddleware)
  }
}

/*
 * Rewrites the derived folder index from the columns beside it. Only index
 * columns are touched, never the payload: `modify` hands over the stored row
 * as it is, and the crypto middleware leaves a sealed payload sealed on the
 * way back out — so this runs correctly whether the account is encrypted,
 * locked, or neither.
 */
function backfillMailboxDates(tx: Transaction): PromiseLike<unknown> {
  return tx
    .table<EmailRow>('emails')
    .toCollection()
    .modify((row) => {
      row.mailboxDates = (row.mailboxIds ?? []).map((m) =>
        mailboxDateKey(m, row.receivedAt, row.threadId),
      )
    })
}

export const db = new MelDb()
