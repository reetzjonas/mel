import type { EmailHeader } from '../domain/email'
import type { Mailbox, MailboxRole } from '../domain/mailbox'
import { db, type EmailRow } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { enqueue } from '../sync/outbox'

/** Apply a header mutation locally (optimistic) and mirror the index fields. */
async function patchLocal(
  accountId: string,
  emailId: string,
  mutate: (h: EmailHeader) => void,
): Promise<void> {
  await db.transaction('rw', db.emails, async () => {
    const row = await db.emails.get([accountId, emailId])
    if (!row) return
    const h = openEnvelope(row.payload)
    mutate(h)
    await db.emails.put({
      ...row,
      mailboxIds: Object.keys(h.mailboxIds),
      unread: h.keywords['$seen'] ? 0 : 1,
      flagged: h.keywords['$flagged'] ? 1 : 0,
      payload: sealPlain(h),
    })
  })
}

/** Batched sibling of patchLocal: one transaction, one bulkPut. */
async function patchLocalMany(
  accountId: string,
  emailIds: string[],
  mutate: (h: EmailHeader) => void,
): Promise<void> {
  await db.transaction('rw', db.emails, async () => {
    const rows = await db.emails.bulkGet(emailIds.map((id) => [accountId, id]))
    const next: EmailRow[] = []
    for (const row of rows) {
      if (!row) continue
      const h = openEnvelope(row.payload)
      mutate(h)
      next.push({
        ...row,
        mailboxIds: Object.keys(h.mailboxIds),
        unread: h.keywords['$seen'] ? 0 : 1,
        flagged: h.keywords['$flagged'] ? 1 : 0,
        payload: sealPlain(h),
      })
    }
    await db.emails.bulkPut(next)
  })
}

async function roleMailbox(accountId: string, role: MailboxRole): Promise<Mailbox | null> {
  const rows = await db.mailboxes
    .where('[accountId+role]')
    .equals([accountId, role ?? ''])
    .toArray()
  const first = rows[0]
  return first ? openEnvelope(first.payload) : null
}

export async function setKeyword(
  accountId: string,
  emailId: string,
  keyword: string,
  on: boolean,
): Promise<void> {
  await patchLocal(accountId, emailId, (h) => {
    if (on) h.keywords[keyword] = true
    else delete h.keywords[keyword]
  })
  await enqueue(accountId, {
    kind: 'email.update',
    updates: { [emailId]: { [`keywords/${keyword}`]: on ? true : null } },
  })
}

export const markRead = (a: string, id: string, read = true) => setKeyword(a, id, '$seen', read)
export const setFlagged = (a: string, id: string, on: boolean) => setKeyword(a, id, '$flagged', on)

/** Move to another mailbox (replaces all current mailboxes). Returns an undo. */
export async function moveEmail(
  accountId: string,
  emailId: string,
  toMailboxId: string,
): Promise<() => Promise<void>> {
  const row = await db.emails.get([accountId, emailId])
  const previous = row ? Object.keys(openEnvelope(row.payload).mailboxIds) : []

  await patchLocal(accountId, emailId, (h) => {
    h.mailboxIds = { [toMailboxId]: true }
  })
  await enqueue(accountId, {
    kind: 'email.update',
    updates: { [emailId]: { mailboxIds: { [toMailboxId]: true } } },
  })

  return async () => {
    const ids: Record<string, true> = {}
    for (const id of previous) ids[id] = true
    await patchLocal(accountId, emailId, (h) => {
      h.mailboxIds = ids
    })
    await enqueue(accountId, {
      kind: 'email.update',
      updates: { [emailId]: { mailboxIds: ids } },
    })
  }
}

/**
 * Stalwart does not provision an Archive mailbox, so the first archive action
 * has to create one.
 *
 * Use the id Mailbox/set hands straight back rather than syncing the whole
 * account to look it up afterwards: that sync is by far the slowest thing in
 * this path, and the move needs nothing else from it.
 */
async function ensureArchiveId(accountId: string): Promise<string | null> {
  const existing = await roleMailbox(accountId, 'archive')
  if (existing) return existing.id

  const { connectionFor } = await import('../sync/connections')
  const { syncAccount } = await import('../sync/engine')
  const conn = await connectionFor(accountId)
  const created = await conn.mail?.editMailbox({
    create: { name: 'Archive', parentId: null, role: 'archive' },
  })
  if (created?.id) {
    // Let the sidebar catch up in the background; do not block the move on it.
    void syncAccount(accountId)
    return created.id
  }
  // Another client may have created it concurrently — resync and look again.
  await syncAccount(accountId)
  return (await roleMailbox(accountId, 'archive'))?.id ?? null
}

export async function archiveEmail(accountId: string, emailId: string) {
  const archiveId = await ensureArchiveId(accountId)
  return archiveId ? moveEmail(accountId, emailId, archiveId) : null
}

/** Move to trash, or destroy permanently when already in trash. */
export async function deleteEmail(accountId: string, emailId: string) {
  const trash = await roleMailbox(accountId, 'trash')
  const row = await db.emails.get([accountId, emailId])
  const inTrash = trash && row && openEnvelope(row.payload).mailboxIds[trash.id]
  if (!trash || inTrash) {
    await db.emails.delete([accountId, emailId])
    await db.bodyCache.delete([accountId, emailId])
    await enqueue(accountId, { kind: 'email.destroy', ids: [emailId] })
    return null
  }
  return moveEmail(accountId, emailId, trash.id)
}

/*
 * Bulk variants. Each queues a *single* outbox action carrying every id, so a
 * thousand-message move is one request rather than a thousand — the provider
 * splits it again to respect maxObjectsInSet.
 */

export async function bulkSetKeyword(
  accountId: string,
  emailIds: string[],
  keyword: string,
  on: boolean,
): Promise<void> {
  if (!emailIds.length) return
  await patchLocalMany(accountId, emailIds, (h) => {
    if (on) h.keywords[keyword] = true
    else delete h.keywords[keyword]
  })
  const updates: Record<string, Record<string, unknown>> = {}
  for (const id of emailIds) updates[id] = { [`keywords/${keyword}`]: on ? true : null }
  await enqueue(accountId, { kind: 'email.update', updates })
}

/** Move many messages, replacing their mailboxes. Returns an undo. */
export async function bulkMove(
  accountId: string,
  emailIds: string[],
  toMailboxId: string,
): Promise<() => Promise<void>> {
  const rows = await db.emails.bulkGet(emailIds.map((id) => [accountId, id]))
  const previous = new Map<string, Record<string, true>>()
  for (const row of rows) {
    if (!row) continue
    const ids: Record<string, true> = {}
    for (const id of Object.keys(openEnvelope(row.payload).mailboxIds)) ids[id] = true
    previous.set(row.id, ids)
  }

  await patchLocalMany(accountId, emailIds, (h) => {
    h.mailboxIds = { [toMailboxId]: true }
  })
  const updates: Record<string, Record<string, unknown>> = {}
  for (const id of emailIds) updates[id] = { mailboxIds: { [toMailboxId]: true } }
  await enqueue(accountId, { kind: 'email.update', updates })

  return async () => {
    const back: Record<string, Record<string, unknown>> = {}
    for (const [id, ids] of previous) back[id] = { mailboxIds: ids }
    await db.transaction('rw', db.emails, async () => {
      const current = await db.emails.bulkGet([...previous.keys()].map((id) => [accountId, id]))
      const next: EmailRow[] = []
      for (const row of current) {
        if (!row) continue
        const h = openEnvelope(row.payload)
        h.mailboxIds = previous.get(row.id) ?? h.mailboxIds
        next.push({ ...row, mailboxIds: Object.keys(h.mailboxIds), payload: sealPlain(h) })
      }
      await db.emails.bulkPut(next)
    })
    await enqueue(accountId, { kind: 'email.update', updates: back })
  }
}

export async function bulkArchive(accountId: string, emailIds: string[]) {
  if (!emailIds.length) return null
  const archiveId = await ensureArchiveId(accountId)
  return archiveId ? bulkMove(accountId, emailIds, archiveId) : null
}

/**
 * Trash in one step, or destroy for good when a message already sits in trash —
 * same rule as the single-message delete, applied per id.
 */
export async function bulkDelete(accountId: string, emailIds: string[]) {
  if (!emailIds.length) return null
  const trash = await roleMailbox(accountId, 'trash')
  const rows = await db.emails.bulkGet(emailIds.map((id) => [accountId, id]))

  const destroy: string[] = []
  const move: string[] = []
  for (const row of rows) {
    if (!row) continue
    const inTrash = trash && openEnvelope(row.payload).mailboxIds[trash.id]
    if (!trash || inTrash) destroy.push(row.id)
    else move.push(row.id)
  }

  if (destroy.length) {
    await db.transaction('rw', [db.emails, db.bodyCache], async () => {
      await db.emails.bulkDelete(destroy.map((id) => [accountId, id]))
      await db.bodyCache.bulkDelete(destroy.map((id) => [accountId, id]))
    })
    await enqueue(accountId, { kind: 'email.destroy', ids: destroy })
  }
  // Only the moved half is reversible; a destroy is gone on the server too.
  return move.length && trash ? bulkMove(accountId, move, trash.id) : null
}
