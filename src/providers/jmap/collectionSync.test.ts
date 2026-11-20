import { describe, expect, it, vi } from 'vitest'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import type { Invocation, JmapRequest } from './client/types/core'
import { fetchAll, fetchChanges } from './collectionSync'

/*
 * What the three providers do with this is covered where they are — the point
 * of pulling it together was not to test it a fourth time. What is only
 * testable here is the wire shape the helper produces, which no provider test
 * looks at closely enough to catch.
 */

/**
 * Records every call as the *server* would receive it, answering each emptily.
 *
 * Through JSON, deliberately: the transport serialises the request, and an
 * argument left `undefined` exists as a key in memory but not in the body. A
 * test reading the in-memory object cannot tell the two apart.
 */
function recording() {
  const sent: Array<[string, Record<string, unknown>]> = []
  const transport = {
    fetchRaw: vi.fn(),
    request: (req: JmapRequest) => {
      const onTheWire = JSON.parse(JSON.stringify(req)) as JmapRequest
      for (const [name, args] of onTheWire.methodCalls) {
        sent.push([name, args as Record<string, unknown>])
      }
      return Promise.resolve({
        methodResponses: req.methodCalls.map(
          ([name, , id]: Invocation) => [name, { list: [], state: 's' } as never, id] as Invocation,
        ),
        sessionState: 's',
      })
    },
  } as unknown as Transport
  return { batch: () => new Batch(transport, ['urn:core']), sent }
}

const spec = { type: 'ContactCard', accountId: 'acc', map: (v: unknown) => v }

describe('what goes over the wire', () => {
  it('leaves properties out of the request when a collection wants all of them', async () => {
    /*
     * An explicit `"properties": null` is a different request from sending no
     * properties at all, and a server is within its rights to refuse it. Only
     * an *empty array* would mean "just the id" — which would store rows with
     * no contents at all.
     */
    const { batch, sent } = recording()

    await fetchChanges(batch, spec, 'state-1')

    for (const [name, args] of sent) {
      if (name.endsWith('/get')) expect('properties' in args, name).toBe(false)
    }
  })

  it('sends the named properties on both halves of a delta', async () => {
    // Two gets, one for created and one for updated. A property set applied to
    // only one of them would store full objects for half the changes.
    const { batch, sent } = recording()

    await fetchChanges(batch, { ...spec, properties: ['id', 'name'] }, 'state-1')

    const gets = sent.filter(([name]) => name.endsWith('/get'))
    expect(gets).toHaveLength(2)
    for (const [, args] of gets) expect(args['properties']).toEqual(['id', 'name'])
  })

  it('sends them on a full fetch too', async () => {
    /*
     * The old per-provider copies only did this for deltas, because the one
     * collection with properties (Email) has no full fetch. A collection that
     * grew one later would have quietly fetched whole objects.
     */
    const { batch, sent } = recording()

    await fetchAll(batch, { ...spec, properties: ['id'] })

    expect(sent[0]![1]).toMatchObject({ ids: null, properties: ['id'] })
  })
})

/**
 * A server holding `count` objects that refuses `ids: null` past `max` of
 * them, as RFC 8620 S5.1 has it, and caps a query's `limit` at `cap`.
 * `onQuery` runs before each query is answered, to change things mid-fetch.
 */
function bigServer(opts: {
  count: number
  max: number
  cap?: number
  onQuery?: (n: number) => void
}) {
  let ids = Array.from({ length: opts.count }, (_, i) => `id${i}`)
  let queryState = 'q1'
  let queries = 0
  const sent: Array<[string, Record<string, unknown>]> = []
  const transport = {
    fetchRaw: vi.fn(),
    request: (req: JmapRequest) => {
      const responses: Invocation[] = []
      const byCall = new Map<string, Record<string, unknown>>()
      for (const [name, rawArgs, id] of req.methodCalls) {
        const args = JSON.parse(JSON.stringify(rawArgs)) as Record<string, unknown>
        sent.push([name, args])
        if (name.endsWith('/query')) {
          opts.onQuery?.(queries++)
          const position = args['position'] as number
          const limit = Math.min(args['limit'] as number, opts.cap ?? Infinity)
          const result = { queryState, ids: ids.slice(position, position + limit), position }
          byCall.set(id, result)
          responses.push([name, result as never, id])
        } else {
          let want = args['ids'] as string[] | null | undefined
          const ref = args['#ids'] as { resultOf: string } | undefined
          if (ref) want = byCall.get(ref.resultOf)!['ids'] as string[]
          if (want == null && ids.length > opts.max) {
            responses.push(['error', { type: 'requestTooLarge' } as never, id])
            continue
          }
          const list = (want ?? ids).map((x) => ({ id: x }))
          responses.push([name, { list, state: 's1', notFound: [] } as never, id])
        }
      }
      return Promise.resolve({ methodResponses: responses, sessionState: 's' })
    },
  } as unknown as Transport
  return {
    batch: () => new Batch(transport, ['urn:core']),
    sent,
    removeFirst: () => {
      ids = ids.slice(1)
      queryState = `q${Number(queryState.slice(1)) + 1}`
    },
  }
}

describe('a collection larger than the server will return at once', () => {
  it('pages through /query when ids: null is requestTooLarge', async () => {
    const { batch, sent } = bigServer({ count: 25, max: 10 })

    const page = await fetchAll(batch, { ...spec, pageSize: 10 })

    expect(page.created.map((c) => (c as { id: string }).id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `id${i}`),
    )
    expect(page.newState).toBe('s1')
    const queries = sent.filter(([name]) => name === 'ContactCard/query')
    expect(queries.map(([, a]) => a['position'])).toEqual([0, 10, 20, 25])
    for (const [, a] of queries) expect(a['limit']).toBe(10)
  })

  it('advances by what the server returned when it caps the limit', async () => {
    // Asked for 10, given 4: stepping by 10 would skip six on every page.
    const { batch } = bigServer({ count: 9, max: 3, cap: 4 })

    const page = await fetchAll(batch, { ...spec, pageSize: 10 })

    expect(page.created).toHaveLength(9)
  })

  it('starts over when the query state moves between pages', async () => {
    // One object gone after the first page shifts the rest up by one, so the
    // first object of the second page would never be read.
    const server = bigServer({
      count: 6,
      max: 2,
      onQuery: (n) => {
        if (n === 1) server.removeFirst()
      },
    })

    const page = await fetchAll(server.batch, { ...spec, pageSize: 3 })

    expect(page.created.map((c) => (c as { id: string }).id)).toEqual([
      'id1',
      'id2',
      'id3',
      'id4',
      'id5',
    ])
  })

  it('still fetches in one go when the server allows it', async () => {
    const { batch, sent } = bigServer({ count: 5, max: 10 })

    const page = await fetchAll(batch, { ...spec, pageSize: 10 })

    expect(page.created).toHaveLength(5)
    expect(sent.map(([name]) => name)).toEqual(['ContactCard/get'])
  })
})
