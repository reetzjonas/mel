import { describe, expect, it } from 'vitest'
import { createJmapQuota } from './quota'
import type { Transport } from './client/transport'
import type { Invocation, JmapRequest } from './client/types/core'

function serverAnswering(list: unknown[]) {
  const sent: JmapRequest[] = []
  const transport = {
    request: (req: JmapRequest) => {
      sent.push(req)
      const responses: Invocation[] = req.methodCalls.map(([name, , callId]) => [
        name,
        { accountId: 'acc', state: 's', list, notFound: [] } as never,
        callId,
      ])
      return Promise.resolve({ methodResponses: responses, sessionState: 's' })
    },
  } as unknown as Transport
  return { provider: createJmapQuota(transport, 'acc'), sent }
}

const octets = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  resourceType: 'octets',
  scope: 'account',
  used: 127_106,
  hardLimit: 1_073_741_824,
  ...over,
})

describe('reading the storage quota', () => {
  it('reports what the account uses against its limit', async () => {
    const { provider, sent } = serverAnswering([octets()])
    expect(await provider.storage()).toEqual({ used: 127_106, limit: 1_073_741_824 })
    expect(sent[0]!.methodCalls[0]![0]).toBe('Quota/get')
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ accountId: 'acc', ids: null })
  })

  // An account without a configured limit has no quota object at all, which
  // means unlimited — showing "0 of 0 used" would be a different claim.
  it('reads an absent quota as no limit rather than an empty one', async () => {
    const { provider } = serverAnswering([])
    expect(await provider.storage()).toBeNull()
  })

  it('ignores quotas that are not this account’s octets', async () => {
    const { provider } = serverAnswering([
      octets({ resourceType: 'count', used: 4, hardLimit: 100 }),
      octets({ scope: 'domain', used: 9, hardLimit: 500 }),
    ])
    expect(await provider.storage()).toBeNull()
  })

  it('treats a zero or missing limit as unlimited', async () => {
    expect(await serverAnswering([octets({ hardLimit: 0 })]).provider.storage()).toBeNull()
    expect(await serverAnswering([octets({ hardLimit: null })]).provider.storage()).toBeNull()
  })

  // Stalwart floors usage at zero itself, but the field is a signed number in
  // the spec and a negative bar has nowhere to go.
  it('never reports negative usage', async () => {
    const { provider } = serverAnswering([octets({ used: -5 })])
    expect(await provider.storage()).toEqual({ used: 0, limit: 1_073_741_824 })
  })
})

describe('what it asks the server for', () => {
  it('uses the quota capability', async () => {
    const { provider, sent } = serverAnswering([])
    await provider.storage()
    expect(sent[0]!.using).toContain('urn:ietf:params:jmap:quota')
  })
})
