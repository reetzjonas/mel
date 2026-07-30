import type { Table } from 'dexie'
import { contactSortKey, type AddressBook, type Contact } from '../domain/contact'
import type { EmailHeader } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'
import {
  CannotCalculateChanges,
  type ContactsProvider,
  type MailProvider,
  type SyncPage,
} from '../providers/types'
import {
  db,
  type AddressBookRow,
  type ContactRow,
  type EmailRow,
  type MailboxRow,
} from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { connectionFor } from './connections'

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

function emailRow(accountId: string, h: EmailHeader): EmailRow {
  return {
    accountId,
    id: h.id,
    threadId: h.threadId,
    mailboxIds: Object.keys(h.mailboxIds),
    receivedAt: Date.parse(h.receivedAt),
    unread: h.keywords['$seen'] ? 0 : 1,
    flagged: h.keywords['$flagged'] ? 1 : 0,
    payload: sealPlain(h),
  }
}

async function getState(accountId: string, collection: string): Promise<string | undefined> {
  return (await db.syncState.get([accountId, collection]))?.state
}

async function applyPage<T>(
  accountId: string,
  collection: 'Mailbox' | 'Email',
  page: SyncPage<T>,
  toRow: (accountId: string, v: T) => MailboxRow | EmailRow,
) {
  const table = (collection === 'Mailbox' ? db.mailboxes : db.emails) as Table<
    MailboxRow | EmailRow,
    [string, string]
  >
  await db.transaction('rw', [table, db.syncState], async () => {
    const rows = [...page.created, ...page.updated].map((v) => toRow(accountId, v))
    if (rows.length) await table.bulkPut(rows)
    if (page.destroyedIds.length)
      await table.bulkDelete(page.destroyedIds.map((id) => [accountId, id]))
    await db.syncState.put({ accountId, collection, state: page.newState, updatedAt: Date.now() })
  })
}

async function syncMailboxes(accountId: string, mail: MailProvider) {
  let state = await getState(accountId, 'Mailbox')
  for (;;) {
    let page: SyncPage<Mailbox>
    try {
      page = await mail.syncMailboxes(state)
    } catch (e) {
      if (e instanceof CannotCalculateChanges) {
        await db.mailboxes.where('accountId').equals(accountId).delete()
        page = await mail.syncMailboxes(undefined)
      } else throw e
    }
    // Full fetch replaces everything that vanished server-side.
    if (state === undefined) {
      const serverIds = new Set(page.created.map((m) => m.id))
      const local = await db.mailboxes.where('accountId').equals(accountId).toArray()
      page.destroyedIds = local.filter((r) => !serverIds.has(r.id)).map((r) => r.id)
    }
    await applyPage(accountId, 'Mailbox', page, mailboxRow)
    if (!page.hasMore) return
    state = page.newState
  }
}

async function fullEmailSync(accountId: string, mail: MailProvider) {
  const seen = new Set<string>()
  const finalState = await mail.listAllEmailHeaders(async ({ headers, state }) => {
    for (const h of headers) seen.add(h.id)
    await applyPage(
      accountId,
      'Email',
      { created: headers, updated: [], destroyedIds: [], newState: state, hasMore: false },
      emailRow,
    )
  })
  // Remove local rows the server no longer has.
  const local = await db.emails.where('accountId').equals(accountId).primaryKeys()
  const stale = local.filter((key) => !seen.has((key as [string, string])[1]))
  if (stale.length) await db.emails.bulkDelete(stale as [string, string][])
  await db.syncState.put({
    accountId,
    collection: 'Email',
    state: finalState,
    updatedAt: Date.now(),
  })
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
    await applyPage(accountId, 'Email', page, emailRow)
    if (!page.hasMore) return
    since = page.newState
  }
}

type SyncRow = { accountId: string; id: string; payload: unknown }

/** Generic delta sync for the simple id-keyed collections (contacts, calendars …). */
async function syncCollection<T extends { id: string }>(
  accountId: string,
  collection: string,
  table: Table<SyncRow, [string, string]>,
  fetch: (sinceState?: string) => Promise<SyncPage<T>>,
  toRow: (v: T) => SyncRow,
) {
  let state = (await db.syncState.get([accountId, collection]))?.state
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
      await db.syncState.put({ accountId, collection, state: page.newState, updatedAt: Date.now() })
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

async function syncContacts(accountId: string, contacts: ContactsProvider) {
  await syncCollection<AddressBook>(
    accountId,
    'AddressBook',
    db.addressBooks as unknown as Table<SyncRow, [string, string]>,
    (s) => contacts.syncAddressBooks(s),
    (b) => addressBookRow(accountId, b),
  )
  await syncCollection<Contact>(
    accountId,
    'ContactCard',
    db.contacts as unknown as Table<SyncRow, [string, string]>,
    (s) => contacts.syncContacts(s),
    (c) => contactRow(accountId, c),
  )
}

const running = new Map<string, Promise<void>>()

/**
 * Sync one account (mailboxes + email headers). Coalesces concurrent calls;
 * multi-tab safety via Web Locks (only one tab syncs an account at a time).
 */
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
    })
  })().finally(() => running.delete(accountId))
  running.set(accountId, run)
  return run
}
