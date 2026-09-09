import { describe, expect, it, vi } from 'vitest'
import type { CoreCapability } from './client/types/core'
import type { Transport } from './client/transport'
import { createJmapMail } from './mail'

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
    const { transport, seen } = transportFor(650)
    const mail = createJmapMail(transport, 'acc', limits, 'u', 'd')

    const fetched: string[] = []
    await mail.listAllEmailHeaders(async ({ headers }) => {
      fetched.push(...headers.map((h) => h.id))
    })

    expect(fetched).toHaveLength(650)
    expect(new Set(fetched).size).toBe(650)
    // Contiguous pages, no gaps.
    expect(seen).toEqual([0, 200, 400, 600])
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
