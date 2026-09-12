import { describe, expect, it, vi } from 'vitest'
import type { Contact } from '../../domain/contact'
import { CannotCalculateChanges } from '../types'
import { createJmapContacts } from './contacts'
import type { Transport } from './client/transport'
import type { Invocation, JmapRequest } from './client/types/core'

/**
 * A transport answering each call by its method name, so a test names what
 * the server says rather than counting positions in an array.
 */
function serverAnswering(byName: Record<string, unknown | unknown[]>) {
  const sent: JmapRequest[] = []
  const taken: Record<string, number> = {}
  const transport = {
    request: (req: JmapRequest) => {
      sent.push(req)
      const responses: Invocation[] = req.methodCalls.map(([name, , callId]) => {
        const answer = byName[name]
        const value = Array.isArray(answer)
          ? answer[(taken[name] = (taken[name] ?? 0) + 1) - 1]
          : answer
        if (value && typeof value === 'object' && 'error' in (value as object)) {
          return ['error', (value as { error: unknown }).error as never, callId]
        }
        return [name, (value ?? {}) as never, callId]
      })
      return Promise.resolve({ methodResponses: responses, sessionState: 's' })
    },
    fetchRaw: vi.fn(),
  } as unknown as Transport
  return { provider: createJmapContacts(transport, 'acc'), sent }
}

const card = (over: Partial<Contact> = {}): Contact =>
  ({
    id: 'c1',
    fullName: 'Ada Lovelace',
    given: 'Ada',
    surname: 'Lovelace',
    organization: '',
    emails: [{ label: null, value: 'ada@example.test' }],
    phones: [],
    addresses: [],
    urls: [],
    note: '',
    memberUids: [],
    addressBookIds: { ab: true },
    ...over,
  }) as unknown as Contact

describe('the first sync of contacts', () => {
  it('asks for everything and reports it as created', async () => {
    // Without a state there is nothing to diff against, so the whole list is
    // what "changed".
    const { provider, sent } = serverAnswering({
      'ContactCard/get': { list: [{ id: 'c1', name: { full: 'Ada' } }], state: 's1' },
    })

    const page = await provider.syncContacts(undefined)

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ ids: null })
    expect(page).toMatchObject({ destroyedIds: [], newState: 's1', hasMore: false })
    expect(page.created).toHaveLength(1)
  })
})

describe('a later sync', () => {
  it('asks only for what changed, and fetches both sides in the same request', async () => {
    // Two gets feeding off the changes call by back-reference: one round trip
    // instead of three.
    const { provider, sent } = serverAnswering({
      'ContactCard/changes': {
        created: ['new'],
        updated: ['old'],
        destroyed: ['gone'],
        newState: 's2',
        hasMoreChanges: false,
      },
      'ContactCard/get': [
        { list: [{ id: 'new' }], state: 's2' },
        { list: [{ id: 'old' }], state: 's2' },
      ],
    })

    const page = await provider.syncContacts('s1')

    expect(sent).toHaveLength(1)
    expect(page).toMatchObject({ destroyedIds: ['gone'], newState: 's2', hasMore: false })
    expect(page.created.map((c) => c.id)).toEqual(['new'])
    expect(page.updated.map((c) => c.id)).toEqual(['old'])
  })

  it('says when the server has more to give, so the caller keeps asking', async () => {
    const { provider } = serverAnswering({
      'ContactCard/changes': {
        created: [],
        updated: [],
        destroyed: [],
        newState: 's2',
        hasMoreChanges: true,
      },
      'ContactCard/get': { list: [], state: 's2' },
    })

    expect((await provider.syncContacts('s1')).hasMore).toBe(true)
  })

  it('raises a state the server has forgotten as its own kind of failure', async () => {
    /*
     * The engine catches exactly this to fall back to a full fetch. A generic
     * error would be retried against a state that is never coming back.
     */
    const { provider } = serverAnswering({
      'ContactCard/changes': { error: { type: 'cannotCalculateChanges' } },
      'ContactCard/get': { list: [], state: 's' },
    })

    await expect(provider.syncContacts('ancient')).rejects.toBeInstanceOf(CannotCalculateChanges)
  })
})

describe('writing a contact', () => {
  it('answers with the id the server assigned', async () => {
    const { provider } = serverAnswering({
      'ContactCard/set': { created: { c0: { id: 'server-id' } } },
    })

    await expect(provider.createContact(card())).resolves.toEqual({
      id: 'server-id',
      failure: null,
    })
  })

  it('tells a refusal that will not change from one worth retrying', async () => {
    // The outbox reads exactly this to decide between giving up loudly and
    // backing off.
    const permanent = serverAnswering({
      'ContactCard/set': {
        notCreated: { c0: { type: 'invalidProperties', description: 'no name' } },
      },
    })
    await expect(permanent.provider.createContact(card())).resolves.toMatchObject({
      id: null,
      failure: { type: 'invalidProperties', description: 'no name', permanent: true },
    })

    const transient = serverAnswering({
      'ContactCard/set': { notCreated: { c0: { type: 'serverFail' } } },
    })
    await expect(transient.provider.createContact(card())).resolves.toMatchObject({
      failure: { permanent: false },
    })
  })

  it('reports a set that says nothing at all as a failure, not a success', async () => {
    // Neither created nor notCreated: treating that as done would lose the
    // card while telling the user it was saved.
    const { provider } = serverAnswering({ 'ContactCard/set': {} })

    const r = await provider.createContact(card())

    expect(r.id).toBeNull()
    expect(r.failure).toMatchObject({ type: 'serverFail', permanent: false })
  })

  it('updates under the contact’s own id', async () => {
    const { provider, sent } = serverAnswering({ 'ContactCard/set': {} })

    await expect(provider.updateContact(card({ id: 'c9' }))).resolves.toBeNull()

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ update: { c9: expect.any(Object) } })
  })

  it('surfaces the first refusal when several destroys fail', async () => {
    const { provider } = serverAnswering({
      'ContactCard/set': { notDestroyed: { c1: { type: 'forbidden' }, c2: { type: 'notFound' } } },
    })

    await expect(provider.destroyContacts(['c1', 'c2'])).resolves.toMatchObject({
      type: 'forbidden',
      permanent: true,
    })
  })

  it('is null when the destroy went through', async () => {
    const { provider } = serverAnswering({ 'ContactCard/set': { destroyed: ['c1'] } })
    await expect(provider.destroyContacts(['c1'])).resolves.toBeNull()
  })
})
