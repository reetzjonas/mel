import type { EmailHeader } from '../domain/email'
import type { Mailbox, MailboxRole } from '../domain/mailbox'
import { db } from '../storage/db'
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

async function roleMailbox(accountId: string, role: MailboxRole): Promise<Mailbox | null> {
  const rows = await db.mailboxes.where('[accountId+role]').equals([accountId, role ?? '']).toArray()
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

export async function archiveEmail(accountId: string, emailId: string) {
  let archive = await roleMailbox(accountId, 'archive')
  if (!archive) {
    // Stalwart doesn't provision an Archive mailbox by default — create one.
    const { connectionFor } = await import('../sync/connections')
    const { syncAccount } = await import('../sync/engine')
    const conn = await connectionFor(accountId)
    // Another client may create it concurrently — re-sync and retry either way.
    await conn.mail?.editMailbox({
      create: { name: 'Archive', parentId: null, role: 'archive' },
    })
    await syncAccount(accountId)
    archive = await roleMailbox(accountId, 'archive')
    if (!archive) return null
  }
  return moveEmail(accountId, emailId, archive.id)
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
