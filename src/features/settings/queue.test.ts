import { describe, expect, it } from 'vitest'
import type { OutboxAction } from '../../sync/outbox'
import { describeAction } from './queue'

const email = (updates: Record<string, Record<string, unknown>>): OutboxAction => ({
  kind: 'email.update',
  updates,
})

describe('describeAction', () => {
  it('names a move by what it does, not by the method it uses', () => {
    // Everything about mail goes through email.update — a queue entry reading
    // "email.update" answers "what is stuck?" with the name of a method call.
    const s = describeAction(email({ a: { mailboxIds: { archive: true } } }))
    expect(s.label).toBe('queue.email.move')
  })

  it('tells read state and flags apart', () => {
    expect(describeAction(email({ a: { 'keywords/$seen': true } })).label).toBe('queue.email.read')
    expect(describeAction(email({ a: { 'keywords/$flagged': true } })).label).toBe(
      'queue.email.flag',
    )
  })

  it('falls back to the generic label for a mixed patch', () => {
    const s = describeAction(email({ a: { 'keywords/$seen': true, mailboxIds: { x: true } } }))
    expect(s.label).toBe('queue.email.update')
  })

  it('counts what the action applies to', () => {
    expect(describeAction(email({ a: {}, b: {}, c: {} })).count).toBe(3)
    expect(describeAction({ kind: 'email.destroy', ids: ['a', 'b'] }).count).toBe(2)
    expect(
      describeAction({ kind: 'event.rsvp', eventId: 'e', participantId: 'p', status: 'accepted' })
        .count,
    ).toBe(1)
  })

  it('has a label for every kind of action', () => {
    const kinds: OutboxAction['kind'][] = [
      'email.update',
      'email.destroy',
      'email.send',
      'contact.create',
      'contact.update',
      'contact.destroy',
      'event.create',
      'event.update',
      'event.destroy',
      'event.rsvp',
    ]
    // A new action kind that nobody described would render as an empty line in
    // the queue — which is where people look when something is stuck.
    for (const kind of kinds) {
      const s = describeAction({ kind, updates: {}, ids: [] } as unknown as OutboxAction)
      expect(s.label, kind).toMatch(/^queue\./)
    }
  })
})
