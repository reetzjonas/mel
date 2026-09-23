/**
 * What the server knows about a message after it was handed over for sending
 * (JMAP EmailSubmission, RFC 8621 §7), reduced to what mel shows: per
 * recipient, did it go through.
 */

/** RFC 8621 `delivered`: `queued` still trying, `unknown` handed on with no word back. */
export type Delivered = 'queued' | 'yes' | 'no' | 'unknown'

export interface RecipientStatus {
  email: string
  delivered: Delivered
  /** The last SMTP reply for this recipient, e.g. "550 5.1.2 Mailbox does not exist." */
  smtpReply: string
}

export interface Submission {
  id: string
  emailId: string
  /** When it was (or is to be) sent, as an ISO date. */
  sendAt: string
  undoStatus: 'pending' | 'final' | 'canceled'
  recipients: RecipientStatus[]
}

export interface DeliveryProblems {
  /** Refused for good: the message will not reach them. */
  failed: RecipientStatus[]
  /** Refused for now: the server is still trying. */
  delayed: RecipientStatus[]
}

/*
 * A 4xx reply is a temporary failure (RFC 5321 §4.2.1): the server keeps the
 * message queued and tries again. The reply Stalwart gives for a message it
 * accepted and queued is a 250, so "queued" alone is not a delay.
 */
function isTemporaryFailure(r: RecipientStatus): boolean {
  return r.delivered !== 'yes' && r.delivered !== 'no' && /^4\d\d\b/.test(r.smtpReply)
}

/** Recipients a message did not reach, over all its submissions. */
export function deliveryProblems(submissions: readonly Submission[]): DeliveryProblems {
  const failed: RecipientStatus[] = []
  const delayed: RecipientStatus[] = []
  for (const s of submissions) {
    if (s.undoStatus === 'canceled') continue
    for (const r of s.recipients) {
      if (r.delivered === 'no') failed.push(r)
      else if (isTemporaryFailure(r)) delayed.push(r)
    }
  }
  return { failed, delayed }
}

export function hasFailure(s: Submission): boolean {
  return s.undoStatus !== 'canceled' && s.recipients.some((r) => r.delivered === 'no')
}
