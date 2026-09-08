import type { Mailbox } from '../domain/mailbox'
import { descendantsOf } from '../features/mail/mailboxTree'
import { connectionFor } from '../sync/connections'
import { syncAccount } from '../sync/engine'
import type { MailboxEdit, SetFailure } from '../providers/types'

async function edit(
  accountId: string,
  action: MailboxEdit,
): Promise<{ id: string | null; failure: SetFailure | null }> {
  const conn = await connectionFor(accountId)
  if (!conn.mail)
    return { id: null, failure: { type: 'noProvider', permanent: true } }
  const r = await conn.mail.editMailbox(action)
  await syncAccount(accountId)
  return r
}

const message = (f: SetFailure | null) => (f ? (f.description ?? f.type) : null)

export const createMailbox = (accountId: string, name: string, parentId: string | null) =>
  edit(accountId, { create: { name, parentId } }).then((r) => message(r.failure))

export const renameMailbox = (accountId: string, id: string, name: string) =>
  edit(accountId, { update: { id, name } }).then((r) => message(r.failure))

/** Why a delete was refused, so the UI can offer the matching way out. */
export type DeleteBlocker = 'hasChild' | 'hasEmail' | 'other'

export interface DeleteOutcome {
  ok: boolean
  blocker?: DeleteBlocker
  message?: string
}

/**
 * The server's own folder list.
 *
 * Deliberately not the local mirror: the whole reason a delete gets refused
 * with mailboxHasChild is that the server knows about a subfolder, and if our
 * copy were complete we would not be in this position. Asking the server keeps
 * the recursive delete correct even when the local list is behind.
 */
async function serverMailboxes(accountId: string): Promise<Mailbox[]> {
  const conn = await connectionFor(accountId)
  if (!conn.mail) return []
  const page = await conn.mail.syncMailboxes()
  return page.created
}

/** What deleting this folder will actually take, straight from the server. */
export async function mailboxDeleteCost(
  accountId: string,
  id: string,
): Promise<{ children: number; mails: number }> {
  const all = await serverMailboxes(accountId)
  const subtree = [all.find((m) => m.id === id), ...descendantsOf(all, id)].filter(
    (m): m is Mailbox => m !== undefined,
  )
  return {
    children: subtree.length - 1,
    mails: subtree.reduce((n, m) => n + m.totalEmails, 0),
  }
}

/**
 * Delete a folder.
 *
 * The server refuses two cases outright, and both are worth distinguishing
 * rather than dumping the raw message on the user:
 *   mailboxHasChild — subfolders must go first, so `recursive` walks them
 *                     depth-first.
 *   mailboxHasEmail — the folder still holds mail; `withEmails` passes JMAP's
 *                     onDestroyRemoveEmails.
 */
export async function deleteMailbox(
  accountId: string,
  id: string,
  opts: { withEmails?: boolean; recursive?: boolean } = {},
): Promise<DeleteOutcome> {
  if (opts.recursive) {
    // Deepest first: a parent cannot go while it still has children.
    const subtree = descendantsOf(await serverMailboxes(accountId), id).reverse()
    for (const child of subtree) {
      const { failure } = await edit(accountId, {
        destroy: child.id,
        destroyWithEmails: opts.withEmails,
      })
      if (failure) return { ok: false, blocker: blockerOf(failure), message: message(failure) ?? undefined }
    }
  }

  const { failure } = await edit(accountId, { destroy: id, destroyWithEmails: opts.withEmails })
  if (!failure) return { ok: true }

  return { ok: false, blocker: blockerOf(failure), message: message(failure) ?? undefined }
}

function blockerOf(failure: SetFailure): DeleteBlocker {
  if (failure.type === 'mailboxHasChild') return 'hasChild'
  if (failure.type === 'mailboxHasEmail') return 'hasEmail'
  return 'other'
}
