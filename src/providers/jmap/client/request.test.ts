import { describe, expect, it, vi } from 'vitest'
import { Batch, chunkIds } from './request'
import { JmapError, type Transport } from './transport'
import type { Invocation, JmapRequest } from './types/core'

/** A transport that answers with whatever the test hands it. */
function transportAnswering(responses: Invocation[]) {
  const sent: JmapRequest[] = []
  const transport = {
    request: (req: JmapRequest) => {
      sent.push(req)
      return Promise.resolve({ methodResponses: responses, sessionState: 's' })
    },
    fetchRaw: vi.fn(),
  } as unknown as Transport
  return { transport, sent }
}

describe('a batch of calls', () => {
  it('sends them as one request, in order, each with its own id', async () => {
    // One round trip instead of three is the whole point of the batch — the
    // request storm on first login was exactly this going wrong.
    const { transport, sent } = transportAnswering([
      ['Email/query', { ids: ['m1'] }, 'c0'],
      ['Email/get', { list: [] }, 'c1'],
    ])
    const b = new Batch(transport, ['urn:core'])
    b.call('Email/query', { accountId: 'a' })
    b.call('Email/get', { accountId: 'a' })

    expect(b.size).toBe(2)
    await b.send()

    expect(sent).toHaveLength(1)
    expect(sent[0]!.using).toEqual(['urn:core'])
    expect(sent[0]!.methodCalls.map((c) => c[2])).toEqual(['c0', 'c1'])
  })

  it('hands each call its own answer, whatever order they come back in', async () => {
    // JMAP does not promise the responses arrive in the order asked.
    const { transport } = transportAnswering([
      ['Email/get', { list: ['second'] }, 'c1'],
      ['Email/query', { ids: ['first'] }, 'c0'],
    ])
    const b = new Batch(transport, [])
    const q = b.call<{ ids: string[] }>('Email/query', {})
    const g = b.call<{ list: string[] }>('Email/get', {})

    await b.send()

    expect(q.result.ids).toEqual(['first'])
    expect(g.result.list).toEqual(['second'])
  })

  it('builds a back-reference naming the call it points at', async () => {
    // This is what lets a get feed on a query's ids without a second round
    // trip, and the name has to match or the server rejects the reference.
    const { transport } = transportAnswering([['Email/query', {}, 'c0']])
    const b = new Batch(transport, [])
    const q = b.call('Email/query', {})

    expect(q.ref('/ids')).toEqual({ resultOf: 'c0', name: 'Email/query', path: '/ids' })
    await b.send()
  })
})

describe('what a call reports back', () => {
  it('refuses to answer before the batch has been sent', async () => {
    // Reading a result early would otherwise look like an empty answer.
    const { transport } = transportAnswering([])
    const handle = new Batch(transport, []).call('Email/get', {})
    expect(() => handle.result).toThrow(/not sent/i)
  })

  it('raises the server’s error on the call it belongs to', async () => {
    const { transport } = transportAnswering([
      ['error', { type: 'invalidArguments', description: 'bad filter' }, 'c0'],
    ])
    const b = new Batch(transport, [])
    const q = b.call('Email/query', {})

    await b.send()

    expect(q.error).toMatchObject({ type: 'invalidArguments' })
    expect(() => q.result).toThrow(/invalidArguments.*bad filter/)
  })

  it('calls a server failure transient and a bad request not', async () => {
    // The outbox retries one and gives up on the other, so the classification
    // decides whether a queued action survives.
    const failing = transportAnswering([['error', { type: 'serverFail' }, 'c0']])
    const bServer = new Batch(failing.transport, [])
    const serverCall = bServer.call('Email/set', {})
    await bServer.send()
    const serverError = (() => {
      try {
        // The getter is what throws; `void` says the value is not the point.
        void serverCall.result
      } catch (e) {
        return e as JmapError
      }
    })()!
    expect(serverError.transient).toBe(true)

    const rejecting = transportAnswering([['error', { type: 'invalidArguments' }, 'c0']])
    const bBad = new Batch(rejecting.transport, [])
    const badCall = bBad.call('Email/set', {})
    await bBad.send()
    const badError = (() => {
      try {
        void badCall.result
      } catch (e) {
        return e as JmapError
      }
    })()!
    expect(badError.transient).toBe(false)
  })

  it('treats a call the server never answered as a failure, not as silence', async () => {
    /*
     * A missing response used to leave the handle looking unsent, so the
     * caller would wait on an answer that was never coming. It is an error
     * with a name instead.
     */
    const { transport } = transportAnswering([['Email/query', {}, 'c0']])
    const b = new Batch(transport, [])
    b.call('Email/query', {})
    const orphan = b.call('Email/get', {})

    await b.send()

    expect(orphan.error).toMatchObject({ type: 'serverFail' })
    expect(() => orphan.result).toThrow(/no response/)
  })
})

describe('chunkIds', () => {
  it('leaves a list the server can take in one go alone', () => {
    expect(chunkIds(['a', 'b'], 10)).toEqual([['a', 'b']])
    expect(chunkIds(['a', 'b'], 2)).toEqual([['a', 'b']])
  })

  it('splits at the limit, keeping every id and its order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const chunks = chunkIds(ids, 2)

    expect(chunks).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(chunks.flat()).toEqual(ids)
  })

  it('sends everything in one chunk rather than none for a nonsense limit', () => {
    /*
     * A server that reports no usable maximum once produced an *empty*
     * request that came back successful — every mutation in it silently
     * dropped. Too large a request is refused visibly; losing the caller's
     * work is not.
     */
    const ids = ['a', 'b', 'c']
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chunkIds(ids, limit), `limit ${limit}`).toEqual([ids])
    }
  })

  it('has nothing to split for an empty list', () => {
    expect(chunkIds([], 10)).toEqual([[]])
  })
})
