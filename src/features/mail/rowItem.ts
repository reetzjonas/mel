import type { EmailAddress, EmailHeader } from '../../domain/email'
import type { Conversation } from './conversations'

/**
 * What a row stands for. A single message and a whole conversation differ only
 * in how many messages they carry, so both render through one component rather
 * than two that drift apart — `ids` is what the row's actions apply to, which
 * for a conversation is its messages *in the listed mailbox* and never the
 * copies elsewhere.
 *
 * Kept apart from `ThreadList.tsx` (a lone helpers-and-a-component file
 * breaks Fast Refresh — see `docs/notes/fast-refresh.md`) since
 * `mail.$mailboxId.tsx` needs `messageItem`/`conversationItem` too, to build
 * the same row list `useSelection` indexes into (see `lib/selection.ts`) —
 * it owns the selection because it also renders the sibling
 * `SelectionToolbar`, but the row shape a conversation vs. a lone message
 * produces belongs here, not duplicated at that call site.
 */
export interface RowItem {
  /** The message shown: the only one, or the newest of the conversation. */
  email: EmailHeader
  ids: string[]
  /** Messages in the conversation across folders; 1 for a lone message. */
  count: number
  people: EmailAddress[]
  unread: boolean
  flagged: boolean
  hasAttachment: boolean
}

export function messageItem(email: EmailHeader): RowItem {
  return {
    email,
    ids: [email.id],
    count: 1,
    people: email.from,
    unread: !email.keywords['$seen'],
    flagged: Boolean(email.keywords['$flagged']),
    hasAttachment: email.hasAttachment,
  }
}

export function conversationItem(conversation: Conversation): RowItem {
  return {
    email: conversation.latest,
    ids: conversation.ids,
    count: conversation.messages.length,
    people: conversation.participants,
    unread: conversation.unread,
    flagged: conversation.flagged,
    hasAttachment: conversation.hasAttachment,
  }
}
