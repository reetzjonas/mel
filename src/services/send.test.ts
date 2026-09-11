import { describe, expect, it } from 'vitest'
import type { EmailBody, EmailHeader } from '../domain/email'
import { buildDraftInit, buildReply } from './send'

const header = (over: Partial<EmailHeader> = {}): EmailHeader =>
  ({
    id: 'draft-1',
    threadId: 't1',
    mailboxIds: { drafts: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: 'Alice', email: 'alice@localhost' }],
    to: [{ name: null, email: 'bob@localhost' }],
    cc: [],
    subject: 'Half written',
    receivedAt: '2026-09-11T10:00:00Z',
    sentAt: null,
    preview: '',
    hasAttachment: false,
    size: 10,
    ...over,
  }) as EmailHeader

const body = (over: Partial<EmailBody> = {}): EmailBody => ({
  emailId: 'draft-1',
  html: '<p>so far</p>',
  text: 'so far',
  attachments: [],
  messageId: ['<m1@localhost>'],
  references: null,
  ...over,
})

describe('buildDraftInit', () => {
  it('carries the draft id, so autosave replaces the message instead of forking it', () => {
    expect(buildDraftInit(header(), body()).draftId).toBe('draft-1')
  })

  it('fills the recipients and the subject from the draft', () => {
    const init = buildDraftInit(header({ cc: [{ name: null, email: 'carol@localhost' }] }), body())
    expect(init.to).toEqual([{ name: null, email: 'bob@localhost' }])
    expect(init.cc).toEqual([{ name: null, email: 'carol@localhost' }])
    expect(init.subject).toBe('Half written')
  })

  it('reads Bcc back from the body, which is the only place it exists', () => {
    const init = buildDraftInit(header(), body({ bcc: [{ name: null, email: 'dan@localhost' }] }))
    expect(init.bcc).toEqual([{ name: null, email: 'dan@localhost' }])
    // A body cached before Bcc was fetched must not become `undefined` fields.
    expect(buildDraftInit(header(), body()).bcc).toEqual([])
  })

  it('opens the stored HTML as the whole content, not as a quote', () => {
    const init = buildDraftInit(header(), body())
    expect(init.bodyHtml).toContain('so far')
    expect(init.quotedHtml).toBeUndefined()
  })

  it('turns a plain-text draft into paragraphs rather than a code block', () => {
    const init = buildDraftInit(header(), body({ html: null, text: 'one\ntwo\n\nthree' }))
    expect(init.bodyHtml).toBe('<p>one<br>two</p><p>three</p>')
    expect(init.bodyHtml).not.toContain('<pre>')
  })

  it('escapes plain text instead of reopening it as markup', () => {
    const init = buildDraftInit(header(), body({ html: null, text: '<script>x</script> & co' }))
    expect(init.bodyHtml).toBe('<p>&lt;script>x&lt;/script> &amp; co</p>')
  })

  it('keeps real attachments by blob id and drops inline parts', () => {
    const init = buildDraftInit(
      header(),
      body({
        attachments: [
          {
            partId: '2',
            blobId: 'b1',
            type: 'text/plain',
            name: 'note.txt',
            disposition: 'attachment',
            cid: null,
            size: 12,
          },
          {
            partId: '3',
            blobId: 'b2',
            type: 'image/png',
            name: 'logo.png',
            disposition: 'inline',
            cid: 'logo@x',
            size: 99,
          },
          {
            partId: '4',
            blobId: null,
            type: 'image/png',
            name: 'gone.png',
            disposition: 'attachment',
            cid: null,
            size: 5,
          },
        ],
      }),
    )
    expect(init.attachments).toEqual([
      { blobId: 'b1', localKey: null, name: 'note.txt', type: 'text/plain', size: 12 },
    ])
  })

  it('survives a body that could not be fetched', () => {
    const init = buildDraftInit(header(), null)
    expect(init.bodyHtml).toBe('')
    expect(init.attachments).toEqual([])
    expect(init.draftId).toBe('draft-1')
  })
})

describe('buildReply', () => {
  const incoming = (over: Partial<EmailHeader> = {}) =>
    header({
      id: 'mail-1',
      mailboxIds: { inbox: true },
      keywords: { $seen: true },
      from: [{ name: 'Bob', email: 'bob@localhost' }],
      to: [{ name: null, email: 'alice@localhost' }],
      subject: 'Projektstand',
      messageId: ['<m1@localhost>'],
      references: null,
      ...over,
    })

  /*
   * The regression from issue #48: the threading headers used to come from the
   * body cache alone, so a reply composed before the body had been fetched —
   * from the list by keyboard, or from a reading pane still showing its
   * skeleton — went out with nothing for the server to thread on.
   */
  it('threads a reply composed before the body is cached', () => {
    const init = buildReply(incoming(), null, 'reply', 'alice@localhost')
    expect(init.inReplyTo).toEqual(['<m1@localhost>'])
    expect(init.references).toEqual(['<m1@localhost>'])
  })

  it('keeps the existing chain and appends what is being answered', () => {
    const init = buildReply(
      incoming({ references: ['<root@localhost>'] }),
      null,
      'reply',
      'alice@localhost',
    )
    expect(init.references).toEqual(['<root@localhost>', '<m1@localhost>'])
  })

  it('falls back to the body for headers cached before they carried this', () => {
    const stale = incoming({ messageId: undefined, references: undefined })
    const init = buildReply(
      stale,
      body({ messageId: ['<m9@localhost>'] }),
      'reply',
      'alice@localhost',
    )
    expect(init.inReplyTo).toEqual(['<m9@localhost>'])
  })

  it('leaves the fields off entirely when neither side knows the id', () => {
    const unknown = incoming({ messageId: null, references: null })
    const init = buildReply(unknown, null, 'reply', 'alice@localhost')
    expect(init.inReplyTo).toBeUndefined()
    expect(init.references).toBeUndefined()
  })

  // A forward is not an answer to anything, so it carries the chain but must
  // not claim to reply to the message it quotes.
  it('carries references but no In-Reply-To on a forward', () => {
    const init = buildReply(incoming(), null, 'forward', 'alice@localhost')
    expect(init.references).toEqual(['<m1@localhost>'])
    expect(init.inReplyTo).toBeUndefined()
  })
})
