import { describe, expect, it } from 'vitest'
import { deliveryProblems, hasFailure, type RecipientStatus, type Submission } from './submission'

const to = (
  email: string,
  delivered: RecipientStatus['delivered'],
  smtpReply = '',
): RecipientStatus => ({
  email,
  delivered,
  smtpReply,
})
const sent = (
  recipients: RecipientStatus[],
  undoStatus: Submission['undoStatus'] = 'final',
): Submission => ({
  id: 's',
  emailId: 'e',
  sendAt: '2026-09-23T20:00:00Z',
  undoStatus,
  recipients,
})

describe('deliveryProblems', () => {
  it('names a refused recipient and says nothing about the rest', () => {
    const refused = to('nobody@example.com', 'no', '550 5.1.2 Mailbox does not exist.')
    const problems = deliveryProblems([
      sent([
        refused,
        to('bob@example.com', 'yes'),
        to('carol@example.com', 'unknown', '250 2.1.5 Queued'),
      ]),
    ])
    expect(problems).toEqual({ failed: [refused], delayed: [] })
  })

  it('calls a 4xx while still queued a delay, not a failure', () => {
    // Stalwart answers "250 2.1.5 Queued" for every accepted message; only a
    // temporary refusal from the far side is worth mentioning.
    const later = to('bob@example.com', 'queued', '451 4.7.1 Try again later')
    expect(deliveryProblems([sent([later])])).toEqual({ failed: [], delayed: [later] })
    expect(deliveryProblems([sent([to('bob@example.com', 'queued', '250 2.1.5 Queued')])])).toEqual(
      {
        failed: [],
        delayed: [],
      },
    )
  })

  it('ignores a cancelled send', () => {
    expect(deliveryProblems([sent([to('a@b.c', 'no')], 'canceled')]).failed).toEqual([])
    expect(hasFailure(sent([to('a@b.c', 'no')], 'canceled'))).toBe(false)
    expect(hasFailure(sent([to('a@b.c', 'no')]))).toBe(true)
    expect(hasFailure(sent([to('a@b.c', 'unknown')]))).toBe(false)
  })
})
