import { describe, expect, it } from 'vitest'
import type { JmapEmail, JmapMailbox } from '../client/types/mail'
import { toEmailBody, toEmailHeader, toMailbox } from './mail'

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
      htmlBody: [
        {
          partId: '0',
          blobId: 'b',
          size: 10,
          name: null,
          type: 'text/plain',
          disposition: null,
          cid: null,
        },
      ],
      textBody: [
        {
          partId: '0',
          blobId: 'b',
          size: 10,
          name: null,
          type: 'text/plain',
          disposition: null,
          cid: null,
        },
      ],
      bodyValues: { '0': { value: 'Hello there' } },
    }
    const body = toEmailBody(e)
    expect(body.html).toBeNull()
    expect(body.text).toBe('Hello there')
  })

  it('keeps a real HTML part as html', () => {
    const e: JmapEmail = {
      ...base,
      htmlBody: [
        {
          partId: '0',
          blobId: 'b',
          size: 10,
          name: null,
          type: 'text/html',
          disposition: null,
          cid: null,
        },
      ],
      textBody: [
        {
          partId: '1',
          blobId: 'b2',
          size: 5,
          name: null,
          type: 'text/plain',
          disposition: null,
          cid: null,
        },
      ],
      bodyValues: { '0': { value: '<p>Hi</p>' }, '1': { value: 'Hi' } },
    }
    const body = toEmailBody(e)
    expect(body.html).toBe('<p>Hi</p>')
    expect(body.text).toBe('Hi')
  })
})

describe('toMailbox', () => {
  const box = (over: Partial<JmapMailbox> = {}): JmapMailbox =>
    ({ id: 'b1', name: 'Inbox', parentId: null, role: null, sortOrder: 3, ...over }) as JmapMailbox

  it('keeps a role the app knows how to act on', () => {
    expect(toMailbox(box({ role: 'inbox' })).role).toBe('inbox')
    expect(toMailbox(box({ role: 'junk' })).role).toBe('junk')
  })

  it('drops a role it has no meaning for, rather than passing it through', () => {
    // Roles drive archiving, spam and the folder icons; an unknown one
    // treated as real would file mail somewhere nothing looks for it.
    expect(toMailbox(box({ role: 'templates' } as never)).role).toBeNull()
    expect(toMailbox(box({ role: null })).role).toBeNull()
  })

  it('survives a server that omits the sort order', () => {
    expect(toMailbox(box({ sortOrder: undefined as never })).sortOrder).toBe(0)
  })
})

describe('toEmailHeader', () => {
  const mail = (over: Partial<JmapEmail> = {}): JmapEmail =>
    ({
      id: 'm1',
      threadId: 't1',
      size: 10,
      receivedAt: '2026-09-09T10:00:00Z',
      ...over,
    }) as JmapEmail

  it('keeps only the flags that are actually set', () => {
    // JMAP sends `false` as readily as omitting the key, and the list styles
    // unread off the presence of $seen — a stored `false` would read as set.
    const h = toEmailHeader(mail({ keywords: { $seen: true, $flagged: false } }))
    expect(h.keywords).toEqual({ $seen: true })
    expect('$flagged' in h.keywords).toBe(false)
  })

  it('does the same for the mailboxes a message is in', () => {
    const h = toEmailHeader(mail({ mailboxIds: { inbox: true, archive: false } }))
    expect(h.mailboxIds).toEqual({ inbox: true })
  })

  it('fills in for every field a server may leave out', () => {
    // A message with no subject, no sender and no preview is ordinary; the
    // list must not have to guard each one separately.
    const h = toEmailHeader(mail())
    expect(h).toMatchObject({
      from: [],
      to: [],
      cc: [],
      subject: null,
      sentAt: null,
      preview: '',
      hasAttachment: false,
      messageId: null,
    })
  })

  it('carries the addresses across as the app spells them', () => {
    const h = toEmailHeader(
      mail({
        from: [{ name: 'Ada', email: 'ada@example.test' }],
        to: [{ name: null, email: 'b@x' }],
      }),
    )
    expect(h.from).toEqual([{ name: 'Ada', email: 'ada@example.test' }])
    expect(h.to).toEqual([{ name: null, email: 'b@x' }])
  })
})

describe('toEmailBody, on the parts of a message', () => {
  it('joins a body split across several parts', () => {
    const body = toEmailBody({
      id: 'm1',
      textBody: [
        { partId: '1', type: 'text/plain' },
        { partId: '2', type: 'text/plain' },
      ],
      bodyValues: { '1': { value: 'first' }, '2': { value: 'second' } },
    } as never)
    expect(body.text).toBe('first\nsecond')
  })

  it('is null rather than empty when the server sent no value for the part', () => {
    // An empty string would render as a blank message body; null is what the
    // reading pane treats as "not fetched".
    const body = toEmailBody({
      id: 'm1',
      textBody: [{ partId: '9', type: 'text/plain' }],
      bodyValues: {},
    } as never)
    expect(body.text).toBeNull()
  })

  it('reports no unsubscribe for a message that offers none', () => {
    expect(toEmailBody({ id: 'm1' } as never).unsubscribe).toBeNull()
  })

  it('carries the unsubscribe headers through when they are there', () => {
    const body = toEmailBody({
      id: 'm1',
      'header:List-Unsubscribe:asURLs': ['https://example.test/u'],
      'header:List-Unsubscribe-Post:asText': 'List-Unsubscribe=One-Click',
    } as never)
    expect(body.unsubscribe).toEqual({
      https: ['https://example.test/u'],
      mailto: [],
      oneClick: true,
    })
  })
})
