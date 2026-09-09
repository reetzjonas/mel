import type { Mailbox } from '../../domain/mailbox'

const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
}

export interface MailboxNode {
  mailbox: Mailbox
  depth: number
}

const bySibling = (a: Mailbox, b: Mailbox) =>
  (ROLE_ORDER[a.role ?? ''] ?? 9) - (ROLE_ORDER[b.role ?? ''] ?? 9) ||
  a.sortOrder - b.sortOrder ||
  a.name.localeCompare(b.name)

/**
 * Order folders as a tree: each one followed by its own children.
 *
 * A flat list sorted globally scatters subfolders among unrelated folders —
 * they are on screen, but nothing says whose children they are, which makes a
 * parent look childless right up until the server refuses to delete it.
 *
 * Anything whose parent is missing from the list is treated as a root, so a
 * partial mirror hides no folders at all.
 */
export function mailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
  const known = new Set(mailboxes.map((m) => m.id))
  const childrenOf = new Map<string | null, Mailbox[]>()
  for (const m of mailboxes) {
    const parent = m.parentId && known.has(m.parentId) ? m.parentId : null
    const siblings = childrenOf.get(parent) ?? []
    siblings.push(m)
    childrenOf.set(parent, siblings)
  }

  const out: MailboxNode[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const mailbox of (childrenOf.get(parentId) ?? []).sort(bySibling)) {
      out.push({ mailbox, depth })
      walk(mailbox.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Every descendant of `id`, deepest last. */
export function descendantsOf(mailboxes: Mailbox[], id: string): Mailbox[] {
  const kids = mailboxes.filter((m) => m.parentId === id)
  return kids.flatMap((k) => [k, ...descendantsOf(mailboxes, k.id)])
}

/**
 * Where a folder may be moved to.
 *
 * Excludes itself and every descendant — a folder placed beneath its own child
 * would detach that whole subtree — and its current parent, which would change
 * nothing. Role folders are excluded as well: Inbox, Trash and the rest have
 * meaning to the server and to every other client, and nesting user folders
 * inside them invites rules and filters that quietly do the wrong thing.
 */
export function moveTargets(mailboxes: Mailbox[], mailbox: Mailbox): Mailbox[] {
  const forbidden = new Set([mailbox.id, ...descendantsOf(mailboxes, mailbox.id).map((m) => m.id)])
  return mailboxTree(mailboxes)
    .map((n) => n.mailbox)
    .filter(
      (m) =>
        m.role === null &&
        m.mayCreateChild &&
        !forbidden.has(m.id) &&
        m.id !== mailbox.parentId,
    )
}
