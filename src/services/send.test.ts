import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailBody, EmailHeader } from '../domain/email'
import type { Identity } from '../domain/identity'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

/** Everything that was queued, with the options it was queued under. */
const enqueued: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = []
const cancelled: number[] = []
vi.mock('../sync/outbox', () => ({
  enqueue: (_a: string, action: Record<string, unknown>, opts?: Record<string, unknown>) => {
    enqueued.push([action, opts])
    return Promise.resolve(enqueued.length)
  },
  cancel: (seq: number) => {
    cancelled.push(seq)
    return Promise.resolve(true)
  },
}))

const identities = vi.fn(async () => [{ id: 'i1', email: 'alice@example.test' }] as unknown[])
const saveDraftOnServer = vi.fn(async (..._a: unknown[]) => 'new-draft' as string | null)
let mailProvider: unknown
vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ mail: mailProvider }),
}))

const {
  buildDraftInit,
  buildReply,
  discardDraft,
  getIdentities,
  parseAddresses,
  quoteBlock,
  saveDraft,
  sendMail,
  stageAttachment,
} = await import('./send')

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
    const init = buildReply(ACC, incoming(), null, 'reply', 'alice@localhost')
    expect(init.inReplyTo).toEqual(['<m1@localhost>'])
    expect(init.references).toEqual(['<m1@localhost>'])
  })

  it('keeps the existing chain and appends what is being answered', () => {
    const init = buildReply(
      ACC,
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
      ACC,
      stale,
      body({ messageId: ['<m9@localhost>'] }),
      'reply',
      'alice@localhost',
    )
    expect(init.inReplyTo).toEqual(['<m9@localhost>'])
  })

  it('leaves the fields off entirely when neither side knows the id', () => {
    const unknown = incoming({ messageId: null, references: null })
    const init = buildReply(ACC, unknown, null, 'reply', 'alice@localhost')
    expect(init.inReplyTo).toBeUndefined()
    expect(init.references).toBeUndefined()
  })

  /*
   * Issue #49: the composer used to be handed a null body and quote it, which
   * produced an empty blockquote and silently dropped the message being
   * answered. It now gets the source instead and fetches it itself.
   */
  it('defers the quote instead of quoting nothing when the body is not cached', () => {
    const init = buildReply(ACC, incoming(), null, 'reply', 'alice@localhost')
    expect(init.quotedHtml).toBeUndefined()
    expect(init.quoteSource).toEqual({ accountId: ACC, header: incoming(), mode: 'reply' })
  })

  it('quotes straight away when the body is already there', () => {
    const init = buildReply(ACC, incoming(), body(), 'reply', 'alice@localhost')
    expect(init.quoteSource).toBeUndefined()
    expect(init.quotedHtml).toContain('so far')
  })

  it('defers a forward the same way, keeping its own header line', () => {
    const init = buildReply(ACC, incoming(), null, 'forward', 'alice@localhost')
    expect(init.quotedHtml).toBeUndefined()
    expect(init.quoteSource?.mode).toBe('forward')
    expect(quoteBlock(incoming(), body(), 'forward')).toContain('Forwarded message')
  })

  // A forward is not an answer to anything, so it carries the chain but must
  // not claim to reply to the message it quotes.
  it('carries references but no In-Reply-To on a forward', () => {
    const init = buildReply(ACC, incoming(), null, 'forward', 'alice@localhost')
    expect(init.references).toEqual(['<m1@localhost>'])
    expect(init.inReplyTo).toBeUndefined()
  })
})

describe('parseAddresses', () => {
  it('takes the plain addresses people type, separated either way', () => {
    expect(parseAddresses('a@x.test, b@y.test; c@z.test')).toEqual([
      { name: null, email: 'a@x.test' },
      { name: null, email: 'b@y.test' },
      { name: null, email: 'c@z.test' },
    ])
  })

  it('pulls the address out of the form every other client puts on the clipboard', () => {
    /*
     * This went wrong in the real thing: the whole string landed in the
     * address field, and the server did not refuse it — it wrote the message
     * down addressed to `Ada Lovelace <ada@example.com` with the stray `>`
     * as the display name. Nothing said so until the mail bounced.
     */
    expect(parseAddresses('Ada Lovelace <ada@example.com>')).toEqual([
      { name: 'Ada Lovelace', email: 'ada@example.com' },
    ])
  })

  it('keeps a quoted name together, commas and all', () => {
    // Outlook quotes exactly this way, and splitting inside the quotes turns
    // one recipient into two unusable ones.
    expect(parseAddresses('"Lovelace, Ada" <ada@example.com>, b@y.test')).toEqual([
      { name: 'Lovelace, Ada', email: 'ada@example.com' },
      { name: null, email: 'b@y.test' },
    ])
  })

  it('mixes the two forms in one field', () => {
    expect(parseAddresses('plain@x.test, Ada <ada@y.test>')).toEqual([
      { name: null, email: 'plain@x.test' },
      { name: 'Ada', email: 'ada@y.test' },
    ])
  })

  it('drops what cannot be an address at all', () => {
    // Typing a name and stopping is ordinary; it must not become a recipient.
    expect(parseAddresses('Ada Lovelace')).toEqual([])
    expect(parseAddresses('  ,  ; ')).toEqual([])
    expect(parseAddresses('')).toEqual([])
    // Angle brackets with nothing usable inside are no better than none.
    expect(parseAddresses('Ada <not-an-address>')).toEqual([])
  })

  it('leaves an address with no display name unnamed rather than blank', () => {
    expect(parseAddresses('<ada@example.com>')).toEqual([{ name: null, email: 'ada@example.com' }])
  })
})

const ACC = 'a1'

const identity = { id: 'i1', name: 'Alice', email: 'alice@example.test' } as Identity

const fields = {
  to: [{ name: null, email: 'bob@example.test' }],
  cc: [],
  bcc: [],
  subject: 'Rechnung',
  html: '<p>hi</p>',
  text: 'hi',
  attachments: [],
}

async function putMailbox(id: string, role: string) {
  await db.mailboxes.put({
    accountId: ACC,
    id,
    role: role as never,
    parentId: null,
    sortOrder: 0,
    payload: sealPlain({ id, name: role, role, parentId: null } as never),
  })
}

beforeEach(async () => {
  enqueued.length = 0
  cancelled.length = 0
  vi.clearAllMocks()
  identities.mockImplementation(async () => [{ id: 'i1', email: 'alice@example.test' }])
  saveDraftOnServer.mockImplementation(async () => 'new-draft')
  mailProvider = {
    identities: () => identities(),
    saveDraft: (...a: unknown[]) => saveDraftOnServer(...a),
  }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  await db.mailboxes.where('accountId').equals(ACC).delete()
  await db.emails.where('accountId').equals(ACC).delete()
  await db.blobCache.where('accountId').equals(ACC).delete()
})

describe('the addresses this account may send from', () => {
  it('asks the server once per account', async () => {
    // The compose form opens often and these do not change within a session;
    // a round trip each time delays the form for nothing.
    await getIdentities('cache-me')
    await getIdentities('cache-me')

    expect(identities).toHaveBeenCalledTimes(1)
  })

  it('is an empty list, not a failure, without a mail provider', async () => {
    // A contacts-only server: compose is hidden, and nothing here should throw
    // on the way to finding that out.
    mailProvider = null

    await expect(getIdentities('no-mail')).resolves.toEqual([])
  })
})

describe('attaching a file', () => {
  it('keeps the bytes on the device and uploads only at send time', async () => {
    /*
     * Composing has to work offline, so the file goes into the blob cache and
     * the attachment carries a local key instead of a server blob id. The
     * outbox swaps one for the other when the message actually goes out.
     */
    const file = new File([new Uint8Array([1, 2, 3])], 'Rechnung.pdf', { type: 'application/pdf' })

    const att = await stageAttachment(ACC, file)

    expect(att).toMatchObject({
      blobId: null,
      name: 'Rechnung.pdf',
      type: 'application/pdf',
      size: 3,
    })
    const row = await db.blobCache.get([ACC, att.localKey!])
    expect(new Uint8Array(openEnvelope(row!.payload).data)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('gives a file with no type one rather than sending none', async () => {
    // A drag from some file managers arrives without a type, and an upload
    // without a Content-Type is not a valid one.
    const att = await stageAttachment(ACC, new File(['x'], 'notes'))

    expect(att.type).toBe('application/octet-stream')
  })
})

describe('sending', () => {
  it('refuses when the account has no Drafts or Sent folder', async () => {
    /*
     * The send is built as a draft that the server moves to Sent on success.
     * Without both ids there is nowhere to put it, and queueing anyway would
     * lose the message inside a failing outbox action.
     */
    await putMailbox('mb-drafts', 'drafts')

    await expect(sendMail(ACC, identity, fields)).rejects.toThrow(/Drafts\/Sent/)
    expect(enqueued).toEqual([])
  })

  it('queues it behind an undo window instead of sending at once', async () => {
    // The ten seconds are the whole feature: until they pass, the message can
    // still be taken back, and nothing has left the device.
    await putMailbox('mb-drafts', 'drafts')
    await putMailbox('mb-sent', 'sent')

    const { undo } = await sendMail(ACC, identity, fields)

    expect(enqueued[0]![0]).toMatchObject({
      kind: 'email.send',
      mailboxIds: { drafts: 'mb-drafts', sent: 'mb-sent' },
    })
    expect(enqueued[0]![1]).toEqual({ delayMs: 10_000 })

    await undo()
    expect(cancelled).toEqual([1])
  })

  it('sends from the identity, not from whatever the account is labelled', async () => {
    // Stalwart matches the submission against the identity; a From built from
    // the account label is refused as forbiddenFrom.
    await putMailbox('mb-drafts', 'drafts')
    await putMailbox('mb-sent', 'sent')

    await sendMail(ACC, identity, fields)

    expect(enqueued[0]![0]['mail']).toMatchObject({
      identityId: 'i1',
      from: { name: 'Alice', email: 'alice@example.test' },
    })
  })
})

describe('autosaving a draft', () => {
  beforeEach(() => putMailbox('mb-drafts', 'drafts'))

  it('reports the new id and that the server took it', async () => {
    await expect(saveDraft(ACC, identity, fields, 'old')).resolves.toEqual({
      id: 'new-draft',
      ok: true,
    })
  })

  it('keeps the old id and says it did not save, rather than looking identical', async () => {
    /*
     * Replacing a draft answers with an id either way, so `ok` is the only
     * thing that can tell a save from a failure. The Save button draws
     * "saved" off it; autosave ignores it and tries again on the next change.
     */
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await expect(saveDraft(ACC, identity, fields, 'old')).resolves.toEqual({ id: 'old', ok: false })

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    saveDraftOnServer.mockRejectedValue(new Error('server said no'))
    await expect(saveDraft(ACC, identity, fields, 'old')).resolves.toEqual({ id: 'old', ok: false })

    saveDraftOnServer.mockResolvedValue(null)
    await expect(saveDraft(ACC, identity, fields, 'old')).resolves.toEqual({ id: 'old', ok: false })
  })

  it('does not try without a Drafts folder to put it in', async () => {
    await db.mailboxes.where('accountId').equals(ACC).delete()

    await expect(saveDraft(ACC, identity, fields, null)).resolves.toEqual({ id: null, ok: false })
    expect(saveDraftOnServer).not.toHaveBeenCalled()
  })

  it('never queues an attachment with a draft', async () => {
    // Autosave runs on a timer; uploading the staged files on every keystroke
    // would put a copy of each on the server per save.
    await saveDraft(ACC, identity, fields, null)

    expect(saveDraftOnServer.mock.calls[0]![0]).toMatchObject({ attachments: [] })
  })
})

describe('discarding the autosaved draft after a send', () => {
  it('takes the local row away at once and the server copy through the queue', async () => {
    // The row has to go immediately or the sent message sits in Drafts on
    // screen; the server side can wait for the outbox like any other write.
    await db.emails.put({
      accountId: ACC,
      id: 'draft-1',
      threadId: 't',
      receivedAt: 0,
      mailboxIds: ['mb-drafts'],
      mailboxDates: [],
      unread: 0,
      flagged: 0,
      payload: sealPlain({ id: 'draft-1' } as never),
    })

    await discardDraft(ACC, 'draft-1')

    expect(await db.emails.get([ACC, 'draft-1'])).toBeUndefined()
    expect(enqueued[0]![0]).toEqual({ kind: 'email.destroy', ids: ['draft-1'] })
  })
})
