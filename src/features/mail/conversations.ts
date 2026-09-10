import {
  matchesFilter,
  type EmailAddress,
  type EmailHeader,
  type MailFilter,
} from '../../domain/email'

/**
 * One row of a grouped mail list: every message of a thread we hold, with the
 * newest one in the listed mailbox standing in for it.
 *
 * The counts and participants span folders — your own replies in Sent are part
 * of the exchange and saying "1 message" about a conversation you answered
 * twice is simply wrong. What the row *acts* on is narrower: `ids` holds only
 * the messages that are in the mailbox being listed, so archiving a row from
 * the inbox cannot reach into Sent behind your back.
 */
export interface Conversation {
  threadId: string
  /** Stands in for the row: newest message that is in the listed mailbox. */
  latest: EmailHeader
  /** Every message of the thread we hold, oldest first, across mailboxes. */
  messages: EmailHeader[]
  /** The messages this row acts on: the thread's mail in the listed mailbox. */
  ids: string[]
  /** Senders, oldest first, deduplicated by address. */
  participants: EmailAddress[]
  /** Aggregated over the messages in this mailbox — those are the actionable
   *  ones. An unread copy sitting in Archive must not put a dot on a row whose
   *  own messages have all been read, since nothing here would clear it. */
  unread: boolean
  flagged: boolean
  hasAttachment: boolean
}

function byDateAsc(a: EmailHeader, b: EmailHeader): number {
  return a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0
}

/** Messages whose every mailbox is excluded (trash/junk/drafts from elsewhere). */
export function isHidden(header: EmailHeader, excluded: Set<string>): boolean {
  const boxes = Object.keys(header.mailboxIds)
  return boxes.length > 0 && boxes.every((id) => excluded.has(id))
}

/**
 * Turns the thread order of a mailbox into rows.
 *
 * `headers` is a cache and may be incomplete: a thread whose messages are not
 * materialised yet is skipped rather than rendered half-empty, and the next
 * pass picks it up. Membership is taken from each header, never from the index
 * that produced the order — an index still listing a moved message would
 * otherwise resurrect a row that its own header says has left the folder.
 */
export function buildConversations({
  threadIds,
  members,
  headers,
  mailboxId,
  filter,
  excludedMailboxIds,
}: {
  /** Threads in list order, newest first. */
  threadIds: string[]
  /** threadId → ids of every message of that thread, in any mailbox. */
  members: Map<string, string[]>
  /** id → header, for everything materialised so far. */
  headers: Map<string, EmailHeader>
  mailboxId: string
  filter: MailFilter | undefined
  /** Trash, junk and drafts, unless one of them is the mailbox being listed. */
  excludedMailboxIds?: Set<string>
}): Conversation[] {
  const excluded = excludedMailboxIds ?? new Set<string>()
  const out: Conversation[] = []

  for (const threadId of threadIds) {
    const all: EmailHeader[] = []
    for (const id of members.get(threadId) ?? []) {
      const header = headers.get(id)
      if (header && !isHidden(header, excluded)) all.push(header)
    }
    if (!all.length) continue
    all.sort(byDateAsc)

    const here = all.filter((h) => h.mailboxIds[mailboxId] && matchesFilter(h, filter))
    const latest = here[here.length - 1]
    // Nothing of this thread is in the mailbox any more (moved, or filtered
    // out): the row has no message to stand for and no message to act on.
    if (!latest) continue

    const participants: EmailAddress[] = []
    const seen = new Set<string>()
    for (const message of all) {
      for (const address of message.from) {
        const key = address.email.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        participants.push(address)
      }
    }

    out.push({
      threadId,
      latest,
      messages: all,
      ids: here.map((h) => h.id),
      participants,
      unread: here.some((h) => !h.keywords['$seen']),
      flagged: here.some((h) => Boolean(h.keywords['$flagged'])),
      hasAttachment: all.some((h) => h.hasAttachment),
    })
  }

  return out
}

/** A message of the open thread, or a run of them folded into one band. */
export type ThreadSlot = { index: number } | { folded: number[] }

/** How many messages at the end of a long thread stay unfolded. */
const KEEP_TAIL = 2
/** Below this, folding hides less than the band costs to explain. */
const MIN_FOLD = 2

/**
 * Folds the middle out of a long conversation.
 *
 * Kept: the first message, the last two, the one you have open, and anything
 * that arrived while you were reading — that last one is the whole point of
 * showing it, so it never lands in a band. Everything else collapses into
 * runs, and a run only becomes a band if it hides at least `MIN_FOLD`
 * messages; folding one message away is pure loss.
 *
 * Ten replies would otherwise push the message you came to read off the
 * screen, which is what a thread view is supposed to prevent.
 */
export function foldThread({
  count,
  expandedIndex,
  arrived,
  showAll = false,
}: {
  count: number
  expandedIndex: number
  /** Indices that turned up while the pane was open. */
  arrived?: Set<number>
  showAll?: boolean
}): ThreadSlot[] {
  const pinned = (i: number) =>
    i === 0 || i === expandedIndex || i >= count - KEEP_TAIL || Boolean(arrived?.has(i))

  const slots: ThreadSlot[] = []
  let run: number[] = []
  const flush = () => {
    if (!run.length) return
    if (!showAll && run.length >= MIN_FOLD) slots.push({ folded: run })
    else for (const i of run) slots.push({ index: i })
    run = []
  }
  for (let i = 0; i < count; i++) {
    if (pinned(i)) {
      flush()
      slots.push({ index: i })
    } else run.push(i)
  }
  flush()
  return slots
}
