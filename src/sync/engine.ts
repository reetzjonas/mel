import type { Table } from 'dexie'
import type { EmailHeader } from '../domain/email'
import type { Mailbox } from '../domain/mailbox'
import { CannotCalculateChanges, type MailProvider, type SyncPage } from '../providers/types'
import { db, type EmailRow, type MailboxRow } from '../storage/db'
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
      if (!conn.mail) return
      await syncMailboxes(accountId, conn.mail)
      await syncEmails(accountId, conn.mail)
    })
  })().finally(() => running.delete(accountId))
  running.set(accountId, run)
  return run
}
