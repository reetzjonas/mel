import type { Mailbox, MailboxRole } from '../domain/mailbox'
import { db } from './db'
import { openEnvelope } from './envelope'

/**
 * Finding the folder a role points at — Inbox, Trash, Drafts, Sent.
 *
 * Two copies of this lived in services/, one answering with the mailbox and
 * one with its id. The id-only copy still read the whole row, which means
 * decrypting a payload to reach a column sitting beside it.
 *
 * `MailboxRole` includes null, because a folder may have none — but asking
 * for "the folder with no role" is not a question with one answer, so this
 * takes only a real role and the callers cannot pose it.
 */
type NamedRole = Exclude<MailboxRole, null>

export async function roleMailboxId(accountId: string, role: NamedRole): Promise<string | null> {
  // primaryKeys(), not toArray(): index-only, so no payload is opened. The key
  // is [accountId, id], and it is the id half that is wanted here.
  const keys = await db.mailboxes.where('[accountId+role]').equals([accountId, role]).primaryKeys()
  return keys[0]?.[1] ?? null
}

/** The same lookup, for a caller that needs more than the id. */
export async function roleMailbox(accountId: string, role: NamedRole): Promise<Mailbox | null> {
  const rows = await db.mailboxes.where('[accountId+role]').equals([accountId, role]).toArray()
  const first = rows[0]
  return first ? openEnvelope(first.payload) : null
}
