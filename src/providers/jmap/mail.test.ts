import { describe, expect, it, vi } from 'vitest'
import type { CoreCapability } from './client/types/core'
import type { Transport } from './client/transport'
import { parseSearch } from '../../lib/searchParser'
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
