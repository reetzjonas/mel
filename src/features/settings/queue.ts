import type { MsgKey } from '../../lib/i18n'
import type { OutboxAction } from '../../sync/outbox'

/**
 * What a queued action says it will do, in one line.
 *
 * A queue that only listed `email.update` would answer "what is stuck?" with
 * the name of a method call. The description is built from the action's own
 * payload — which is the encrypted half of the row, so it exists only in the
 * app, never in a column.
 *
 * `count` is spliced into the label by the caller rather than baked in here:
 * the two languages put the number in different places, and a pure function
 * that returns a key plus a number keeps both honest.
 */
export interface ActionSummary {
  label: MsgKey
  /** How many things it applies to; 1 unless the action carries a list. */
  count: number
}

/**
 * `email.update` is the one action whose name says nothing: moving, flagging
 * and marking read all go through it. The patch tells them apart — a move
 * replaces `mailboxIds` wholesale, the flags are `keywords/$…` paths — and
 * "Move 12 messages" is the only version of this line anyone can act on.
 */
function describeEmailUpdate(updates: Record<string, Record<string, unknown>>): MsgKey {
  const paths = Object.values(updates).flatMap((patch) => Object.keys(patch))
  if (!paths.length) return 'queue.email.update'
  if (paths.every((p) => p === 'mailboxIds' || p.startsWith('mailboxIds/')))
    return 'queue.email.move'
  if (paths.every((p) => p === 'keywords/$seen')) return 'queue.email.read'
  if (paths.every((p) => p === 'keywords/$flagged')) return 'queue.email.flag'
  return 'queue.email.update'
}

export function describeAction(action: OutboxAction): ActionSummary {
  switch (action.kind) {
    case 'email.update':
      return {
        label: describeEmailUpdate(action.updates),
        count: Object.keys(action.updates).length,
      }
    case 'email.destroy':
      return { label: 'queue.email.destroy', count: action.ids.length }
    case 'email.send':
      return { label: 'queue.email.send', count: 1 }
    case 'contact.create':
      return { label: 'queue.contact.create', count: 1 }
    case 'contact.update':
      return { label: 'queue.contact.update', count: 1 }
    case 'contact.destroy':
      return { label: 'queue.contact.destroy', count: action.ids.length }
    case 'event.create':
      return { label: 'queue.event.create', count: 1 }
    case 'event.update':
      return { label: 'queue.event.update', count: 1 }
    case 'event.destroy':
      return { label: 'queue.event.destroy', count: action.ids.length }
    case 'event.rsvp':
      return { label: 'queue.event.rsvp', count: 1 }
  }
}
