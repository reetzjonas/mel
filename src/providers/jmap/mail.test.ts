import { describe, expect, it, vi } from 'vitest'
import type { CoreCapability, Invocation, JmapRequest } from './client/types/core'
import type { Transport } from './client/transport'
import { parseSearch } from '../../lib/searchParser'
import { CannotCalculateChanges } from '../types'
import { createJmapMail, jmapSearchFilter } from './mail'

const limits = {
  maxSizeUpload: 1,
  maxConcurrentUpload: 1,
  maxSizeRequest: 1,
  maxConcurrentRequests: 1,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
} as CoreCapability

/** A transport that serves `total` ids out of a paged Email/query. */
function pagedTransport(total: number) {
  const calls: Array<{ position: number; limit: number }> = []
  const transport: Transport = {
    fetchRaw: vi.fn(),
    request: async (req) => {
      const [, args, id] = req.methodCalls[0]!
      const position = (args['position'] as number) ?? 0
      const limit = (args['limit'] as number) ?? 0
      calls.push({ position, limit })
      const ids = Array.from({ length: Math.max(0, Math.min(limit, total - position)) }, (_, i) =>
        String(position + i),
      )
      return {
        methodResponses: [['Email/query', { ids, position, total }, id]],
        sessionState: 's',
      } as never
    },
  }
  return { transport, calls }
}

const mailFor = (total: number) => {
  const { transport, calls } = pagedTransport(total)
  return { mail: createJmapMail(transport, 'acc', limits, 'u', 'd'), calls }
}

describe('queryMailboxIds', () => {
  it('pages until the mailbox is exhausted', async () => {
    const { mail, calls } = mailFor(2500)
    const r = await mail.queryMailboxIds('mb', 50_000)

    expect(r.total).toBe(2500)
    expect(r.ids).toHaveLength(2500)
    expect(new Set(r.ids).size).toBe(2500)
    // Pages of 1000, and it must stop rather than ask for a fourth empty one.
    expect(calls.map((c) => c.position)).toEqual([0, 1000, 2000])
  })

  it('stops at the ceiling and still reports the real total', async () => {
    const { mail } = mailFor(12_480)
    const r = await mail.queryMailboxIds('mb', 2000)

    expect(r.ids).toHaveLength(2000)
    // The caller needs the true size to admit it stopped short.
    expect(r.total).toBe(12_480)
  })

  it('handles an exact multiple of the page size without an extra request', async () => {
    const { mail, calls } = mailFor(2000)
    const r = await mail.queryMailboxIds('mb', 50_000)
    expect(r.ids).toHaveLength(2000)
    expect(calls).toHaveLength(2)
  })

  it('copes with an empty mailbox', async () => {
    const { mail, calls } = mailFor(0)
    const r = await mail.queryMailboxIds('mb', 50_000)
    expect(r).toEqual({ ids: [], total: 0 })
    expect(calls).toHaveLength(1)
  })

  /*
   * "Select everything in this folder" runs server-side, so the filter has to
   * travel with it. Without this the toolbar would select mail the filtered
   * list is not showing — and then act on it.
   */
  describe('narrows the query to the active filter', () => {
    function filterFor() {
      const filters: unknown[] = []
      const transport: Transport = {
        fetchRaw: vi.fn(),
        request: async (req) => {
          const [, args, id] = req.methodCalls[0]!
          filters.push(args['filter'])
          return {
            methodResponses: [['Email/query', { ids: [], position: 0, total: 0 }, id]],
            sessionState: 's',
          } as never
        },
      }
      return { mail: createJmapMail(transport, 'acc', limits, 'u', 'd'), filters }
    }

    it('asks for messages without $seen when filtering unread', async () => {
      const { mail, filters } = filterFor()
      await mail.queryMailboxIds('mb', 10, 'unread')
      expect(filters[0]).toEqual({ inMailbox: 'mb', notKeyword: '$seen' })
    })

    it('asks for messages with $flagged when filtering flagged', async () => {
      const { mail, filters } = filterFor()
      await mail.queryMailboxIds('mb', 10, 'flagged')
      expect(filters[0]).toEqual({ inMailbox: 'mb', hasKeyword: '$flagged' })
    })

    it('leaves the query alone with no filter', async () => {
      const { mail, filters } = filterFor()
      await mail.queryMailboxIds('mb', 10)
      expect(filters[0]).toEqual({ inMailbox: 'mb' })
    })
  })
})

describe('listAllEmailHeaders', () => {
  /** Serves ids and headers for a paged Email/query + Email/get pair. */
  function transportFor(total: number) {
    const seen: number[] = []
    const transport: Transport = {
      fetchRaw: vi.fn(),
      request: async (req) => {
        const [, args] = req.methodCalls[0]!
        const position = (args['position'] as number) ?? 0
        const limit = (args['limit'] as number) ?? 0
        seen.push(position)
        const ids = Array.from({ length: Math.max(0, Math.min(limit, total - position)) }, (_, i) =>
          String(position + i),
        )
        return {
          methodResponses: [
            ['Email/query', { ids, position, total }, req.methodCalls[0]![2]],
            [
              'Email/get',
              { list: ids.map((id) => ({ id, mailboxIds: {}, keywords: {} })), state: 's' },
              req.methodCalls[1]![2],
            ],
            ['Email/get', { list: [], state: 's' }, req.methodCalls[2]![2]],
          ],
          sessionState: 's',
        } as never
      },
    }
    return { transport, seen }
  }

  it('walks every message rather than skipping between pages', async () => {
    // Regression: the cursor advanced by a different page size than the one
    // requested, so four out of every five messages were never fetched and
    // folders looked emptier locally than they were on the server.
    const { transport, seen } = transportFor(1100)
    const mail = createJmapMail(transport, 'acc', limits, 'u', 'd')

    const fetched: string[] = []
    await mail.listAllEmailHeaders(async ({ headers }) => {
      fetched.push(...headers.map((h) => h.id))
    })

    expect(fetched).toHaveLength(1100)
    expect(new Set(fetched).size).toBe(1100)
    // Contiguous pages of the fixture's maxObjectsInGet (500), no gaps.
    expect(seen).toEqual([0, 500, 1000])
  })

  it("pages by the server's own limit, not a fixed guess", async () => {
    // Regression: a hardcoded page size of 200 ignored what the server
    // actually permits (maxObjectsInGet), turning a full sync of a large
    // mailbox into far more round trips than necessary — reported as a
    // "request storm" of hundreds of Email/query calls on first login
    // against a mail provider with a much higher limit.
    const generous = { ...limits, maxObjectsInGet: 3000 } as CoreCapability
    const { transport, seen } = transportFor(2999)
    const mail = createJmapMail(transport, 'acc', generous, 'u', 'd')

    await mail.listAllEmailHeaders(async () => {})

    expect(seen).toEqual([0])
  })
})

describe('setEmails when the server is stingy about its limits', () => {
  /** Captures what actually goes over the wire. */
  function recordingTransport() {
    const sent: Array<Record<string, unknown>> = []
    const transport: Transport = {
      fetchRaw: vi.fn(),
      request: async (req) => {
        const [, args, id] = req.methodCalls[0]!
        sent.push(args)
        const update = (args['update'] ?? {}) as Record<string, unknown>
        return {
          methodResponses: [
            [
              'Email/set',
              { updated: Object.fromEntries(Object.keys(update).map((k) => [k, null])) },
              id,
            ],
          ],
          sessionState: 's',
        } as never
      },
    }
    return { transport, sent }
  }

  it('still sends the update when maxObjectsInSet is missing', async () => {
    // Regression: an undefined chunk size produced one *empty* chunk, so the
    // request went out carrying nothing and reported success — every move,
    // flag and mark-read was silently dropped against such a server.
    const { transport, sent } = recordingTransport()
    const stingy = { maxObjectsInGet: 500 } as CoreCapability
    const mail = createJmapMail(transport, 'acc', stingy, 'u', 'd')

    const outcome = await mail.setEmails({ 'mail-1': { mailboxIds: { inbox: true } } }, [])

    expect(sent[0]?.['update']).toEqual({ 'mail-1': { mailboxIds: { inbox: true } } })
    expect(outcome.updated).toEqual(['mail-1'])
    expect(outcome.failed).toEqual({})
  })

  it('reports an id the server acknowledged in neither direction', async () => {
    const transport: Transport = {
      fetchRaw: vi.fn(),
      request: async (req) =>
        ({
          methodResponses: [['Email/set', { updated: {} }, req.methodCalls[0]![2]]],
          sessionState: 's',
        }) as never,
    }
    const mail = createJmapMail(transport, 'acc', limits, 'u', 'd')

    const outcome = await mail.setEmails({ 'mail-1': { keywords: {} } }, [])

    // Silence here used to read as success, so the outbox dropped the action.
    expect(outcome.updated).toEqual([])
    expect(outcome.failed['mail-1']).toMatchObject({ permanent: false })
  })
})

/*
 * What someone types in the search box, as the server will read it. Tested
 * through parseSearch rather than hand-built query objects: the pair is what
 * ships, and a mistranslation here returns the wrong mail without any sign
 * that a translation happened at all.
 */
describe('jmapSearchFilter', () => {
  const filterFor = (input: string, mailboxId?: string) =>
    jmapSearchFilter(parseSearch(input)!, mailboxId)

  it('passes a bare term through as a full-text condition', () => {
    expect(filterFor('rechnung')).toEqual({ text: 'rechnung' })
  })

  it('does not wrap a single condition in an AND it does not need', () => {
    // Servers are entitled to their own query planning; handing them a
    // one-element conjunction is noise they then have to see through.
    expect(filterFor('from:ada@example.test')).toEqual({ from: 'ada@example.test' })
  })

  it('combines several terms into one conjunction', () => {
    expect(filterFor('from:ada subject:rechnung')).toEqual({
      operator: 'AND',
      conditions: [{ from: 'ada' }, { subject: 'rechnung' }],
    })
  })

  it('turns is:unread and is:read into opposite keyword tests', () => {
    // The inversion is the whole meaning of the word and nothing downstream
    // would notice it flipping: both spellings return mail either way.
    expect(filterFor('is:unread')).toEqual({ notKeyword: '$seen' })
    expect(filterFor('is:read')).toEqual({ hasKeyword: '$seen' })
  })

  it('maps the other flags people search by', () => {
    expect(filterFor('is:flagged')).toEqual({ hasKeyword: '$flagged' })
    expect(filterFor('has:attachment')).toEqual({ hasAttachment: true })
  })

  it('gives a bare date the time of day JMAP expects', () => {
    // `before:2026-09-01` is a date; the filter takes an instant, and without
    // one the server has to guess which.
    expect(filterFor('before:2026-09-01')).toEqual({ before: '2026-09-01T00:00:00Z' })
    expect(filterFor('after:2026-01-31')).toEqual({ after: '2026-01-31T00:00:00Z' })
  })

  it('keeps the shape of an OR, nesting and all', () => {
    expect(filterFor('urgent from:a OR from:b')).toEqual({
      operator: 'AND',
      conditions: [
        { text: 'urgent' },
        { operator: 'OR', conditions: [{ from: 'a' }, { from: 'b' }] },
      ],
    })
  })

  it('scopes the whole query to a folder when one is being listed', () => {
    // The folder is not part of what was typed, so it is added around the
    // query rather than into it — an OR inside must not escape the folder.
    expect(filterFor('from:a OR from:b', 'mb-1')).toEqual({
      operator: 'AND',
      conditions: [
        { inMailbox: 'mb-1' },
        { operator: 'OR', conditions: [{ from: 'a' }, { from: 'b' }] },
      ],
    })
  })
})

/**
 * A transport answering each method call by name, recording what was sent.
 *
 * An array answers repeated calls of the same name in turn — a batch may hold
 * two Email/get calls meaning different things — and a value carrying `error`
 * comes back as the server refusing that one call.
 */
function serverAnswering(
  byName: Record<string, unknown>,
  opts: { accountId?: string; limits?: CoreCapability; upload?: string; download?: string } = {},
) {
  const sent: Array<[string, Record<string, unknown>]> = []
  const taken: Record<string, number> = {}
  const fetchRaw = vi.fn()
  const transport: Transport = {
    fetchRaw,
    request: async (req: JmapRequest) => ({
      methodResponses: req.methodCalls.map(([name, args, id]: Invocation) => {
        sent.push([name, args])
        const answer = byName[name]
        const value = Array.isArray(answer)
          ? answer[(taken[name] = (taken[name] ?? 0) + 1) - 1]
          : answer
        if (value && typeof value === 'object' && 'error' in (value as object)) {
          return ['error', (value as { error: unknown }).error as never, id] as Invocation
        }
        return [name, (value ?? {}) as never, id] as Invocation
      }),
      sessionState: 's',
    }),
  } as never
  const mail = createJmapMail(
    transport,
    opts.accountId ?? 'acc',
    opts.limits ?? limits,
    opts.upload ?? 'u',
    opts.download ?? 'd',
  )
  return { mail, sent, fetchRaw }
}

const outgoing = {
  identityId: 'i1',
  from: { name: 'Alice', email: 'alice@example.test' },
  to: [{ name: null, email: 'bob@example.test' }],
  cc: [],
  bcc: [],
  subject: 'Rechnung',
  html: '<p>hi</p>',
  text: 'hi',
  attachments: [],
  inReplyTo: null,
  references: null,
}

describe('sending a message', () => {
  const boxes = { drafts: 'mb-drafts', sent: 'mb-sent' }

  it('creates it and submits it in one request', async () => {
    // Two round trips would leave a window in which the draft exists and
    // nothing has been sent — and a crash in between leaves it there.
    const { mail, sent } = serverAnswering({
      'Email/set': { created: { draft: { id: 'e1' } } },
      'EmailSubmission/set': { created: { sub: {} } },
    })

    await mail.sendEmail(outgoing as never, boxes)

    expect(sent.map(([name]) => name)).toEqual(['Email/set', 'EmailSubmission/set'])
  })

  it('has the server move it out of drafts once the send succeeded', async () => {
    /*
     * onSuccessUpdateEmail, not a follow-up call: the move has to happen only
     * if the submission actually went through, and only the server knows that
     * in the same breath.
     */
    const { mail, sent } = serverAnswering({
      'Email/set': { created: { draft: { id: 'e1' } } },
      'EmailSubmission/set': { created: { sub: {} } },
    })

    await mail.sendEmail(outgoing as never, boxes)

    const submission = sent.find(([name]) => name === 'EmailSubmission/set')![1]
    expect(submission['onSuccessUpdateEmail']).toEqual({
      '#sub': {
        'mailboxIds/mb-drafts': null,
        'mailboxIds/mb-sent': true,
        'keywords/$draft': null,
      },
    })
  })

  it('leaves out the recipient fields nobody filled in', async () => {
    // An empty cc array is not the same as no cc; some servers reject it.
    const { mail, sent } = serverAnswering({
      'Email/set': { created: { draft: { id: 'e1' } } },
      'EmailSubmission/set': { created: { sub: {} } },
    })

    await mail.sendEmail(outgoing as never, boxes)

    const draft = (sent[0]![1]['create'] as Record<string, Record<string, unknown>>)['draft']!
    expect(draft['cc']).toBeUndefined()
    expect(draft['bcc']).toBeUndefined()
    expect(draft['to']).toHaveLength(1)
  })

  it('raises a refusal from either half, carrying whether it can be retried', async () => {
    // The outbox reads `permanent` to decide between backing off and giving
    // up loudly; a send that failed for good must not be retried for ever.
    const rejected = serverAnswering({
      'Email/set': { notCreated: { draft: { type: 'invalidProperties', description: 'no to' } } },
      'EmailSubmission/set': {},
    })
    await expect(rejected.mail.sendEmail(outgoing as never, boxes)).rejects.toMatchObject({
      message: expect.stringContaining('invalidProperties'),
      permanent: true,
    })

    const refusedSubmission = serverAnswering({
      'Email/set': { created: { draft: { id: 'e1' } } },
      'EmailSubmission/set': { notCreated: { sub: { type: 'forbiddenFrom' } } },
    })
    await expect(refusedSubmission.mail.sendEmail(outgoing as never, boxes)).rejects.toMatchObject({
      permanent: false,
    })
  })
})

describe('saving a draft', () => {
  it('replaces the previous one in the same set', async () => {
    /*
     * Create and destroy together: two calls would leave both copies in the
     * folder if the second never ran, and autosave would breed a draft per
     * keystroke.
     */
    const { mail, sent } = serverAnswering({ 'Email/set': { created: { draft: { id: 'new' } } } })

    await expect(mail.saveDraft(outgoing as never, 'mb-drafts', 'old')).resolves.toBe('new')

    expect(sent).toHaveLength(1)
    expect(sent[0]![1]['destroy']).toEqual(['old'])
  })

  it('destroys nothing on the first save', async () => {
    const { mail, sent } = serverAnswering({ 'Email/set': { created: { draft: { id: 'new' } } } })

    await mail.saveDraft(outgoing as never, 'mb-drafts', null)

    expect(sent[0]![1]['destroy']).toBeUndefined()
  })

  it('answers null when the server created nothing', async () => {
    // The caller keeps the old draft id on null; claiming success would point
    // autosave at a message that does not exist.
    const { mail } = serverAnswering({
      'Email/set': { notCreated: { draft: { type: 'overQuota' } } },
    })

    await expect(mail.saveDraft(outgoing as never, 'mb-drafts', 'old')).resolves.toBeNull()
  })
})

describe('syncing the folder list', () => {
  it('asks for every folder at once when there is no state to diff against', async () => {
    const { mail, sent } = serverAnswering({
      'Mailbox/get': { list: [{ id: 'mb-1', name: 'Inbox' }], state: 'm1' },
    })

    const p = await mail.syncMailboxes(undefined)

    // ids: null is "all of them"; an empty array would mean "none".
    expect(sent[0]![1]['ids']).toBeNull()
    expect(p).toMatchObject({ updated: [], destroyedIds: [], newState: 'm1', hasMore: false })
    expect(p.created).toHaveLength(1)
  })

  it('fetches both sides of a delta in the same request', async () => {
    // Changes plus two gets by back-reference: one round trip rather than
    // three, and the created/updated split survives it.
    const { mail, sent } = serverAnswering({
      'Mailbox/changes': {
        created: ['new'],
        updated: ['old'],
        destroyed: ['gone'],
        newState: 'm2',
        hasMoreChanges: false,
      },
      'Mailbox/get': [
        { list: [{ id: 'new', name: 'New' }] },
        { list: [{ id: 'old', name: 'Old' }] },
      ],
    })

    const p = await mail.syncMailboxes('m1')

    expect(sent.map(([name]) => name)).toEqual(['Mailbox/changes', 'Mailbox/get', 'Mailbox/get'])
    expect(p.created.map((m) => m.id)).toEqual(['new'])
    expect(p.updated.map((m) => m.id)).toEqual(['old'])
    expect(p.destroyedIds).toEqual(['gone'])
  })

  it('raises a forgotten state as its own kind of failure', async () => {
    /*
     * The engine catches exactly this to fall back to a full fetch. A generic
     * error would be retried against a state that is never coming back.
     */
    const { mail } = serverAnswering({
      'Mailbox/changes': { error: { type: 'cannotCalculateChanges' } },
      'Mailbox/get': { list: [] },
    })

    await expect(mail.syncMailboxes('ancient')).rejects.toBeInstanceOf(CannotCalculateChanges)
  })
})

describe('syncing message headers', () => {
  it('asks for the header fields only, never the bodies', async () => {
    /*
     * A delta can carry thousands of messages. Letting the properties default
     * to "everything" would pull every body with it — the difference between
     * a sync and a download of the whole mailbox.
     */
    const { mail, sent } = serverAnswering({
      'Email/changes': { created: [], updated: [], destroyed: [], newState: 'e2' },
      'Email/get': { list: [] },
    })

    await mail.syncEmailHeaders('e1')

    const props = sent[1]![1]['properties'] as string[]
    expect(props).toContain('subject')
    expect(props).not.toContain('bodyValues')
  })

  it('passes on that the server has more to give', async () => {
    const { mail } = serverAnswering({
      'Email/changes': {
        created: [],
        updated: [],
        destroyed: [],
        newState: 'e2',
        hasMoreChanges: true,
      },
      'Email/get': { list: [] },
    })

    expect((await mail.syncEmailHeaders('e1')).hasMore).toBe(true)
  })
})

describe('fetching messages by id', () => {
  it('splits a list the server would refuse in one go', async () => {
    // maxObjectsInGet is a hard server limit, and a request over it is
    // rejected whole — every id in it would be lost.
    const { mail, sent } = serverAnswering(
      { 'Email/get': { list: [] } },
      { limits: { ...limits, maxObjectsInGet: 2 } as CoreCapability },
    )

    await mail.getEmailHeaders(['a', 'b', 'c'])

    expect(sent.map(([, args]) => args['ids'])).toEqual([['a', 'b'], ['c']])
  })

  it('answers null for a body the server does not have', async () => {
    // Deleted elsewhere between the list being drawn and the message opened.
    const { mail } = serverAnswering({ 'Email/get': { list: [] } })

    await expect(mail.getEmailBody('gone')).resolves.toBeNull()
  })

  it('tells a message with no headers from a message that is not there', async () => {
    /*
     * Headers are optional in RFC 8621, so a server may answer the request and
     * still list none. An empty array says "none"; null says "no such
     * message", and the details view shows quite different things for each.
     */
    const withNone = serverAnswering({ 'Email/get': { list: [{ id: 'e1', blobId: 'b1' }] } })
    await expect(withNone.mail.getEmailMetadata('e1')).resolves.toEqual({
      headers: [],
      blobId: 'b1',
    })

    const missing = serverAnswering({ 'Email/get': { list: [] } })
    await expect(missing.mail.getEmailMetadata('gone')).resolves.toBeNull()
  })
})

describe('creating, renaming and deleting a folder', () => {
  it('hands back the id the server assigned', async () => {
    // The first archive uses this id straight away rather than syncing the
    // whole account to look the new folder up.
    const { mail } = serverAnswering({ 'Mailbox/set': { created: { m0: { id: 'mb-new' } } } })

    await expect(
      mail.editMailbox({ create: { name: 'Archive', parentId: null, role: 'archive' } }),
    ).resolves.toEqual({ id: 'mb-new', failure: null })
  })

  it('reports a refused creation instead of a null id on its own', async () => {
    const { mail } = serverAnswering({
      'Mailbox/set': { notCreated: { m0: { type: 'invalidProperties', description: 'taken' } } },
    })

    await expect(mail.editMailbox({ create: { name: 'Archive' } as never })).resolves.toMatchObject(
      {
        id: null,
        failure: { type: 'invalidProperties', permanent: true },
      },
    )
  })

  it('does not send the id as a field when renaming under it', async () => {
    // The id keys the update; repeating it inside the patch asks the server to
    // change a property it treats as immutable.
    const { mail, sent } = serverAnswering({ 'Mailbox/set': {} })

    await expect(mail.editMailbox({ update: { id: 'mb-1', name: 'Bills' } })).resolves.toEqual({
      id: 'mb-1',
      failure: null,
    })

    const update = sent[0]![1]['update'] as Record<string, Record<string, unknown>>
    expect(update['mb-1']).toMatchObject({ name: 'Bills' })
    expect(update['mb-1']!['id']).toBeUndefined()
  })

  it('only removes the messages with a folder when asked to', async () => {
    /*
     * Deleting a folder that still holds mail is refused by default, which is
     * the safe answer — the destructive one has to be chosen explicitly.
     */
    const kept = serverAnswering({ 'Mailbox/set': { destroyed: ['mb-1'] } })
    await kept.mail.editMailbox({ destroy: 'mb-1' })
    expect(kept.sent[0]![1]['onDestroyRemoveEmails']).toBe(false)

    const withMail = serverAnswering({ 'Mailbox/set': { destroyed: ['mb-1'] } })
    await withMail.mail.editMailbox({ destroy: 'mb-1', destroyWithEmails: true })
    expect(withMail.sent[0]![1]['onDestroyRemoveEmails']).toBe(true)
  })

  it('reports a refused delete against the folder it was asked about', async () => {
    const { mail } = serverAnswering({
      'Mailbox/set': { notDestroyed: { 'mb-1': { type: 'mailboxHasEmail' } } },
    })

    await expect(mail.editMailbox({ destroy: 'mb-1' })).resolves.toMatchObject({
      id: 'mb-1',
      failure: { type: 'mailboxHasEmail' },
    })
  })
})

describe('the addresses a message can be sent from', () => {
  it('reads them from the server, with a missing name as an empty one', async () => {
    // The compose form puts this straight into a From line; undefined there
    // would render as the word "undefined".
    const { mail } = serverAnswering({
      'Identity/get': { list: [{ id: 'i1', email: 'alice@example.test' }] },
    })

    await expect(mail.identities()).resolves.toEqual([
      { id: 'i1', name: '', email: 'alice@example.test', replyTo: null },
    ])
  })
})

describe('blobs', () => {
  it('fills the download template with escaped values', async () => {
    /*
     * Every one of these goes into a URL path. A blob id containing a slash,
     * or an attachment named with a space, used to produce a URL pointing
     * somewhere else entirely — a 404 on opening the attachment.
     */
    const { mail, fetchRaw } = serverAnswering(
      {},
      {
        accountId: 'acc/1',
        download: 'https://x.test/{accountId}/{blobId}/{type}/{name}',
      },
    )
    fetchRaw.mockResolvedValue({ blob: () => Promise.resolve(new Blob(['x'])) })

    await mail.downloadBlob('b/2', 'application/pdf', 'Rechnung Mai.pdf')

    expect(fetchRaw).toHaveBeenCalledWith(
      'https://x.test/acc%2F1/b%2F2/application%2Fpdf/Rechnung%20Mai.pdf',
    )
  })

  it('posts an upload with the type the file actually has', async () => {
    const { mail, fetchRaw } = serverAnswering(
      {},
      { accountId: 'acc', upload: 'https://x.test/{accountId}' },
    )
    fetchRaw.mockResolvedValue({
      json: () => Promise.resolve({ blobId: 'b1', size: 3 }),
    })

    await expect(mail.uploadBlob(new Uint8Array([1, 2, 3]).buffer, 'image/png')).resolves.toEqual({
      blobId: 'b1',
      size: 3,
    })
    expect(fetchRaw.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
    })
  })

  it('falls back to a generic type rather than sending none', async () => {
    // A blob staged from the clipboard may arrive without one, and a missing
    // Content-Type is not a valid upload.
    const { mail, fetchRaw } = serverAnswering({}, { upload: 'https://x.test/{accountId}' })
    fetchRaw.mockResolvedValue({ json: () => Promise.resolve({ blobId: 'b1', size: 0 }) })

    await mail.uploadBlob(new ArrayBuffer(0), '')

    expect(fetchRaw.mock.calls[0]![1]).toMatchObject({
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  })
})

describe('searching', () => {
  it('asks for the matches and their snippets in one request', async () => {
    const { mail, sent } = serverAnswering({
      'Email/query': { ids: ['e1'] },
      'SearchSnippet/get': {
        list: [{ emailId: 'e1', subject: null, preview: 'a <mark>bill</mark>' }],
      },
    })

    const r = await mail.searchEmails(parseSearch('bill')!, { limit: 10 })

    expect(sent.map(([name]) => name)).toEqual(['Email/query', 'SearchSnippet/get'])
    expect(r.ids).toEqual(['e1'])
    expect(r.snippets['e1']).toEqual({ subject: null, preview: 'a <mark>bill</mark>' })
  })

  it('still returns the results when the server cannot do snippets', async () => {
    // SearchSnippet is optional. Letting its refusal fail the whole search
    // would turn a cosmetic gap into no results at all.
    const { mail } = serverAnswering({
      'Email/query': { ids: ['e1'] },
      'SearchSnippet/get': { error: { type: 'unknownMethod' } },
    })

    const r = await mail.searchEmails(parseSearch('bill')!, { limit: 10 })

    expect(r.ids).toEqual(['e1'])
    expect(r.snippets).toEqual({})
  })
})

describe('the vacation responder', () => {
  it('reads it as off when the server has never had one set', async () => {
    // VacationResponse is a singleton that may simply not exist yet; an empty
    // list must not read as "enabled with no text".
    const { mail } = serverAnswering({ 'VacationResponse/get': { list: [] } })

    await expect(mail.getVacation()).resolves.toEqual({ enabled: false, subject: '', text: '' })
  })

  it('writes empty fields as null rather than as an empty string', async () => {
    // An empty subject is "no subject", which JMAP spells null; "" would be
    // stored and sent as a blank Subject header.
    const { mail, sent } = serverAnswering({ 'VacationResponse/set': {} })

    await mail.setVacation({ enabled: true, subject: '', text: 'away' })

    const update = sent[0]![1]['update'] as Record<string, Record<string, unknown>>
    expect(update['singleton']).toEqual({ isEnabled: true, subject: null, textBody: 'away' })
  })

  it('raises a refusal instead of reporting it as saved', async () => {
    const { mail } = serverAnswering({
      'VacationResponse/set': {
        notUpdated: { singleton: { type: 'forbidden', description: 'not allowed here' } },
      },
    })

    await expect(mail.setVacation({ enabled: true, subject: 's', text: 't' })).rejects.toThrow(
      'not allowed here',
    )
  })
})
