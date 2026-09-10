import { describe, expect, it } from 'vitest'
import type { JmapEmail } from '../client/types/mail'
import { toEmailBody } from './mail'

const base: Omit<JmapEmail, 'htmlBody' | 'textBody' | 'bodyValues'> = {
  id: 'e1',
  blobId: 'b1',
  threadId: 't1',
  mailboxIds: {},
  keywords: {},
  from: [],
  to: [],
  cc: [],
  receivedAt: '2026-01-01T00:00:00Z',
  size: 0,
}

describe('toEmailBody', () => {
  it('treats a plain-text message as text, not HTML, even when the server mirrors it into htmlBody', () => {
    // RFC 8621 §4.1.4: a message with no real HTML part still gets a
    // `htmlBody` pointing at the plain-text part. Stalwart does this.
    const e: JmapEmail = {
      ...base,
      htmlBody: [{ partId: '0', blobId: 'b', size: 10, name: null, type: 'text/plain', disposition: null, cid: null }],
      textBody: [{ partId: '0', blobId: 'b', size: 10, name: null, type: 'text/plain', disposition: null, cid: null }],
      bodyValues: { '0': { value: 'Hello there' } },
    }
    const body = toEmailBody(e)
    expect(body.html).toBeNull()
    expect(body.text).toBe('Hello there')
  })

  it('keeps a real HTML part as html', () => {
    const e: JmapEmail = {
      ...base,
      htmlBody: [{ partId: '0', blobId: 'b', size: 10, name: null, type: 'text/html', disposition: null, cid: null }],
      textBody: [{ partId: '1', blobId: 'b2', size: 5, name: null, type: 'text/plain', disposition: null, cid: null }],
      bodyValues: { '0': { value: '<p>Hi</p>' }, '1': { value: 'Hi' } },
    }
    const body = toEmailBody(e)
    expect(body.html).toBe('<p>Hi</p>')
    expect(body.text).toBe('Hi')
  })
})
