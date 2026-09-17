import type { Account, Credentials } from '../domain/account'
import { fetchSession } from '../providers/jmap/client/session'
import { createTransport } from '../providers/jmap/client/transport'
import { Cap, type GetResponse } from '../providers/jmap/client/types/core'
import { t } from '../lib/i18n'

/**
 * What a push notification says, for a service worker that has no app around
 * it: the sender and subject of the message that woke it up, fetched from the
 * server, or nothing when the account has not opted in.
 *
 * The StateChange the server pushes (RFC 8620 §7.2) carries no content at all
 * — only "Email changed on account X" — so naming the message costs a session
 * fetch plus one batched request. That is why the feature is off by default.
 *
 * IndexedDB is read through the raw API rather than Dexie: the store layout is
 * the same, and a service worker that pulls in Dexie plus the crypto
 * middleware would be paying for a database it cannot write to anyway.
 */

interface AccountRecord {
  id: string
  encrypted: boolean
  pushDetails?: boolean
  payload: { plain?: { account: Account; credentials: Credentials } }
}

export interface MailNotification {
  title: string
  body: string
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    // No version: this opens what the app created and never upgrades it. A
    // service worker must not be the one deciding the schema.
    const open = indexedDB.open('mel')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => resolve(null)
    open.onblocked = () => resolve(null)
  })
}

/** The unencrypted, opted-in account the changed JMAP account id belongs to. */
async function optedInAccount(
  db: IDBDatabase,
  remoteAccountId: string,
): Promise<AccountRecord | null> {
  if (!db.objectStoreNames.contains('accounts')) return null
  const rows = await request<AccountRecord[]>(
    db.transaction('accounts', 'readonly').objectStore('accounts').getAll(),
  )
  return (
    rows.find(
      (r) =>
        !r.encrypted &&
        r.pushDetails &&
        r.payload.plain?.account.remoteAccountId === remoteAccountId,
    ) ?? null
  )
}

/**
 * The inbox's id, straight out of the local mailbox list.
 *
 * `role` is one of the plaintext index columns every row carries beside its
 * payload, so this answer is available without a key and without a request.
 */
async function inboxId(db: IDBDatabase, accountId: string): Promise<string | null> {
  if (!db.objectStoreNames.contains('mailboxes')) return null
  const index = db
    .transaction('mailboxes', 'readonly')
    .objectStore('mailboxes')
    .index('[accountId+role]')
  const row = await request<{ id?: string } | undefined>(index.get([accountId, 'inbox']))
  return row?.id ?? null
}

interface EmailPeek {
  subject?: string
  from?: Array<{ name?: string | null; email: string }>
}

/** Newest unread message in the inbox, named. */
async function newestUnread(
  account: Account,
  credentials: Credentials,
  mailboxId: string,
): Promise<MailNotification | null> {
  const { apiUrl } = await fetchSession(account.sessionUrl, credentials)
  const transport = createTransport(apiUrl, credentials)
  const res = await transport.request({
    using: [Cap.core, Cap.mail],
    methodCalls: [
      [
        'Email/query',
        {
          accountId: account.remoteAccountId,
          filter: { inMailbox: mailboxId, notKeyword: '$seen' },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: 1,
        },
        'q',
      ],
      [
        'Email/get',
        {
          accountId: account.remoteAccountId,
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: ['subject', 'from'],
        },
        'g',
      ],
    ],
  })
  const get = res.methodResponses.find(([, , id]) => id === 'g')
  if (!get || get[0] === 'error') return null
  const email = (get[1] as unknown as GetResponse<EmailPeek>).list[0]
  if (!email) return null
  const sender = email.from?.[0]
  return {
    title: sender?.name || sender?.email || t('mail.unknownSender'),
    body: email.subject || t('mail.noSubject'),
  }
}

/**
 * The notification for a StateChange, or null to fall back to the generic one.
 *
 * Every failure answers null rather than throwing: an expired password or an
 * unreachable server must still produce "new mail", never a push that wakes
 * the device and then shows nothing.
 */
export async function mailNotificationFor(
  remoteAccountId: string,
): Promise<MailNotification | null> {
  try {
    const db = await openDb()
    if (!db) return null
    try {
      const row = await optedInAccount(db, remoteAccountId)
      const stored = row?.payload.plain
      if (!row || !stored) return null
      const mailboxId = await inboxId(db, row.id)
      if (!mailboxId) return null
      return await newestUnread(stored.account, stored.credentials, mailboxId)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}
