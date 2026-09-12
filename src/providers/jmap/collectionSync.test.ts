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
