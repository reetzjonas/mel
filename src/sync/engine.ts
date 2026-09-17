import type { Table } from 'dexie'
import { contactSortKey, type AddressBook, type Contact } from '../domain/contact'
import type { EmailHeader } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'
import {
  CannotCalculateChanges,
  type CalendarProvider,
  type ContactsProvider,
  type FilesProvider,
  type MailProvider,
  type SyncPage,
} from '../providers/types'
import {
  db,
  type AccountScopedKey,
  type AddressBookRow,
  type ContactRow,
  type MailboxRow,
} from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { toEmailRow } from '../storage/emailRow'
import { connectionFor } from './connections'
import { setFullSyncProgress } from './progress'

function mailboxRow(accountId: string, m: Mailbox): MailboxRow {
  return {
    accountId,
    id: m.id,
    parentId: m.parentId,
    role: m.role,
    sortOrder: m.sortOrder,
    payload: sealPlain(m),
  }
}

/**
 * How much of each object this app knows how to store, as a number that goes
 * up whenever a mapper starts keeping a field it used to drop.
 *
 * Delta sync only ever rewrites a row the *server* reports as changed, so a
 * new field reaches rows already on disk — never. A card cached before mel
 * learned about birthdays keeps no birthday for as long as nobody edits it on
 * the server, and the calendar then shows none: exactly what happened between
 * one device that had been signed in for a while and a newer one, against the
 * same account, which looked for all the world like a rendering bug.
 *
 * Bumping the number here makes the next sync a full one for that collection,
 * once, and nothing else. Leave Email alone unless it is truly worth making
 * every device re-fetch a whole mailbox.
 */
const MODEL_VERSION: Record<string, number> = {
  // 2: birthday, photo, online services and tags (RFC 9553 fields added after
  // the first contacts release).
  ContactCard: 2,
  // 2: executable, which nothing asked the server for until now.
  FileNode: 2,
}

function modelVersion(collection: string): number {
  return MODEL_VERSION[collection] ?? 1
}

/**
 * Where the last sync of this collection got to, or undefined to fetch it all.
 *
 * Undefined also when the cached rows predate a field this app now keeps —
 * there is no cursor that can bring a field nobody asked for at the time.
 */
async function getState(accountId: string, collection: string): Promise<string | undefined> {
  const row = await db.syncState.get([accountId, collection])
  if (!row) return undefined
  return (row.modelVersion ?? 1) === modelVersion(collection) ? row.state : undefined
}

function putState(accountId: string, collection: string, state: string) {
  return db.syncState.put({
    accountId,
    collection,
    state,
    modelVersion: modelVersion(collection),
    updatedAt: Date.now(),
  })
}

/**
 * Write one page of email headers and remember where it got to.
 *
 * Only email: every other collection goes through syncCollection below. Email
 * is the exception because its first pass cannot be a single fetch — see
 * fullEmailSync — so the page comes from two different places.
 */
async function applyEmailPage(accountId: string, page: SyncPage<EmailHeader>) {
  await db.transaction('rw', [db.emails, db.syncState], async () => {
    const rows = [...page.created, ...page.updated].map((h) => toEmailRow(accountId, h))
    if (rows.length) await db.emails.bulkPut(rows)
    if (page.destroyedIds.length)
      await db.emails.bulkDelete(page.destroyedIds.map((id) => [accountId, id]))
    await putState(accountId, 'Email', page.newState)
  })
}

/**
 * Fetch every message header, page by page, newest first.
 *
 * This is the one sync that takes real time — a first login on a large
 * mailbox is tens of thousands of headers — so it reports its progress. Until
 * it did, the list sat on "No messages" for minutes, which is not a slow
 * answer but a wrong one.
 */
async function fullEmailSync(accountId: string, mail: MailProvider) {
  const seen = new Set<string>()
  let done = 0
  // Before the first request, not after it: that request is the longest wait
  // of the lot on a large mailbox, and it is exactly the stretch where the
  // list would otherwise still be calling itself empty.
  setFullSyncProgress(accountId, { done: 0, total: null })
  try {
    const finalState = await mail.listAllEmailHeaders(async ({ headers, state, total }) => {
      for (const h of headers) seen.add(h.id)
      await applyEmailPage(accountId, {
        created: headers,
        updated: [],
        destroyedIds: [],
        newState: state,
        hasMore: false,
      })
      // After the write, not before: what it reports is what is readable.
      done += headers.length
      setFullSyncProgress(accountId, { done, total })
    })
    // Remove local rows the server no longer has.
    const local = await db.emails.where('accountId').equals(accountId).primaryKeys()
    const stale = local.filter((key) => !seen.has((key as [string, string])[1]))
    if (stale.length) await db.emails.bulkDelete(stale as [string, string][])
    await putState(accountId, 'Email', finalState)
  } finally {
    // Including on the way out through an error: a progress line left standing
    // would claim a fetch is still running after it has given up.
    setFullSyncProgress(accountId, null)
  }
}

async function syncEmails(accountId: string, mail: MailProvider) {
  const state = await getState(accountId, 'Email')
  if (!state) return fullEmailSync(accountId, mail)
  let since = state
  for (;;) {
    let page: SyncPage<EmailHeader>
    try {
      page = await mail.syncEmailHeaders(since)
    } catch (e) {
      if (e instanceof CannotCalculateChanges) return fullEmailSync(accountId, mail)
      throw e
    }
    await applyEmailPage(accountId, page)
    if (!page.hasMore) return
    since = page.newState
  }
}

/** What every synced row has; each table adds its own index columns to it. */
type SyncRow = { accountId: string; id: string; payload: unknown }

/**
 * Delta sync for one id-keyed collection: mailboxes, address books, contact
 * cards, calendars, events.
 *
 * Mailboxes used to have their own copy of this, which differed in one place:
 * after wiping the table on a forgotten state it left `state` pointing at the
 * dead cursor, so the prune below was skipped on the refetch. That was
 * harmless only because the wipe had just emptied the table — the two are one
 * function now rather than two that agree by luck.
 *
 * Generic over the row as well as the object, so each caller passes its own
 * table unchanged; typing the parameter as `Table<SyncRow, …>` is what forced
 * four `as unknown as` casts at the call sites.
 */
async function syncCollection<T extends { id: string }, R extends SyncRow>(
  accountId: string,
  collection: string,
  table: Table<R, AccountScopedKey>,
  fetch: (sinceState?: string) => Promise<SyncPage<T>>,
  toRow: (v: T) => R,
) {
  let state = await getState(accountId, collection)
  for (;;) {
    let page: SyncPage<T>
    try {
      page = await fetch(state)
    } catch (e) {
      if (e instanceof CannotCalculateChanges) {
        await table.where('accountId').equals(accountId).delete()
        state = undefined
        page = await fetch(undefined)
      } else throw e
    }
    if (state === undefined) {
      // Full fetch: drop local rows the server no longer has.
      const serverIds = new Set(page.created.map((v) => v.id))
      const local = await table.where('accountId').equals(accountId).toArray()
      page.destroyedIds = local.filter((r) => !serverIds.has(r.id)).map((r) => r.id)
    }
    await db.transaction('rw', [table, db.syncState], async () => {
      const rows = [...page.created, ...page.updated].map(toRow)
      if (rows.length) await table.bulkPut(rows)
      if (page.destroyedIds.length)
        await table.bulkDelete(page.destroyedIds.map((id) => [accountId, id]))
      await putState(accountId, collection, page.newState)
    })
    if (!page.hasMore) return
    state = page.newState
  }
}

function addressBookRow(accountId: string, b: AddressBook): AddressBookRow {
  return { accountId, id: b.id, payload: sealPlain(b) }
}

function contactRow(accountId: string, c: Contact): ContactRow {
  return {
    accountId,
    id: c.id,
    addressBookIds: Object.keys(c.addressBookIds),
    sortKey: contactSortKey(c),
    payload: sealPlain(c),
  }
}

function syncMailboxes(accountId: string, mail: MailProvider) {
  return syncCollection(
    accountId,
    'Mailbox',
    db.mailboxes,
    (s) => mail.syncMailboxes(s),
    (m) => mailboxRow(accountId, m),
  )
}

async function syncContacts(accountId: string, contacts: ContactsProvider) {
  await syncCollection(
    accountId,
    'AddressBook',
    db.addressBooks,
    (s) => contacts.syncAddressBooks(s),
    (b) => addressBookRow(accountId, b),
  )
  await syncCollection(
    accountId,
    'ContactCard',
    db.contacts,
    (s) => contacts.syncContacts(s),
    (c) => contactRow(accountId, c),
  )
}

async function syncCalendarData(accountId: string, calendars: CalendarProvider) {
  await syncCollection(
    accountId,
    'Calendar',
    db.calendars,
    (s) => calendars.syncCalendars(s),
    (c) => ({ accountId, id: c.id, payload: sealPlain(c) }),
  )
  await syncCollection(
    accountId,
    'CalendarEvent',
    db.events,
    (s) => calendars.syncEvents(s),
    (e) => ({
      accountId,
      id: e.id,
      calendarIds: Object.keys(e.calendarIds),
      payload: sealPlain(e),
    }),
  )
}

/**
 * Bring the local file tree up to date on its own.
 *
 * File writes go straight to the server, and the local mirror has to catch up
 * afterwards. Running the whole account sync for that would drag every message
 * header along behind a folder rename, so this is the one collection with a
 * public entry point of its own.
 */
export async function syncFileTree(accountId: string): Promise<void> {
  const conn = await connectionFor(accountId)
  if (conn.files) await syncFiles(accountId, conn.files)
}

function syncFiles(accountId: string, files: FilesProvider) {
  return syncCollection(
    accountId,
    'FileNode',
    db.files,
    (s) => files.syncNodes(s),
    (n) => ({
      accountId,
      id: n.id,
      parentKey: n.parentId ?? '',
      nodeType: n.nodeType,
      payload: sealPlain(n),
    }),
  )
}

const running = new Map<string, Promise<void>>()

/**
 * Sync one account (mailboxes + email headers). Coalesces concurrent calls;
 * multi-tab safety via Web Locks (only one tab syncs an account at a time).
 */
/** Resolves once any in-flight sync for this account has stopped writing. */
export function syncSettled(accountId: string): Promise<void> {
  return running.get(accountId)?.catch(() => {}) ?? Promise.resolve()
}

export function syncAccount(accountId: string): Promise<void> {
  const active = running.get(accountId)
  if (active) return active
  const run = (async () => {
    await navigator.locks.request(`mel-sync-${accountId}`, async () => {
      const conn = await connectionFor(accountId)
      if (conn.mail) {
        await syncMailboxes(accountId, conn.mail)
        await syncEmails(accountId, conn.mail)
      }
      if (conn.contacts) await syncContacts(accountId, conn.contacts)
      if (conn.calendars) await syncCalendarData(accountId, conn.calendars)
      if (conn.files) await syncFiles(accountId, conn.files)
    })
  })().finally(() => running.delete(accountId))
  running.set(accountId, run)
  return run
}
