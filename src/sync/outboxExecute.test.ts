import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'

// jsdom has no Web Locks; the outbox takes one around every flush.
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: { request: (_name: string, fn: () => unknown) => Promise.resolve(fn()) },
})

const ACC = 'acc'
const calls: string[] = []

/** Each provider call records itself and answers with whatever a test set. */
let answers: Record<string, unknown> = {}
const answer = (name: string, fallback: unknown) => {
  calls.push(name)
  return Promise.resolve(name in answers ? answers[name] : fallback)
}

vi.mock('./connections', () => ({
  connectionFor: () =>
    Promise.resolve({
      mail: {
        setEmails: () => answer('setEmails', { updated: [], destroyed: [], failed: {} }),
        sendEmail: () => answer('sendEmail', undefined),
        uploadBlob: () => answer('uploadBlob', { blobId: 'server-blob', size: 3 }),
      },
      contacts: {
        createContact: () => answer('createContact', { id: 'server-id', failure: null }),
        updateContact: () => answer('updateContact', null),
        destroyContacts: () => answer('destroyContacts', null),
      },
      calendars: {
        createEvent: () => answer('createEvent', { id: 'server-id', failure: null }),
        updateEvent: () => answer('updateEvent', null),
        rsvp: () => answer('rsvp', null),
        destroyEvents: () => answer('destroyEvents', null),
      },
    }),
}))
vi.mock('./engine', () => ({ syncAccount: () => Promise.resolve() }))

const { flush } = await import('./outbox')

/** Queue one action and run it. */
async function run(action: Record<string, unknown>) {
  await db.outbox.clear()
  await db.outbox.add({
    accountId: ACC,
    kind: action['kind'] as string,
    status: 'pending',
    attempts: 0,
    notBefore: 0,
    payload: sealPlain(action),
  })
  await flush(ACC)
  return (await db.outbox.toArray())[0]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  calls.length = 0
  answers = {}
})
afterEach(() => vi.useRealTimers())

describe('a queued contact creation', () => {
  it('drops the optimistic row once the server has the real one', async () => {
    /*
     * The temp row was written so the card appeared at once. Leaving it after
     * the server's copy arrives means the same contact twice in the list, for
     * good — nothing else ever deletes it.
     */
    await db.contacts.put({
      accountId: ACC,
      id: 'local-1',
      addressBookIds: ['ab'],
      sortKey: 'ada',
      payload: sealPlain({ id: 'local-1' } as never),
    })

    await run({ kind: 'contact.create', contact: { id: 'local-1' }, tempId: 'local-1' })

    expect(calls).toContain('createContact')
    expect(await db.contacts.get([ACC, 'local-1'])).toBeUndefined()
  })

  it('keeps the optimistic row when the server refused', async () => {
    // Deleting it would take the card away without ever having saved it.
    answers = { createContact: { id: null, failure: { type: 'serverFail', permanent: false } } }
    await db.contacts.put({
      accountId: ACC,
      id: 'local-2',
      addressBookIds: ['ab'],
      sortKey: 'ada',
      payload: sealPlain({ id: 'local-2' } as never),
    })

    await run({ kind: 'contact.create', contact: { id: 'local-2' }, tempId: 'local-2' })

    expect(await db.contacts.get([ACC, 'local-2'])).toBeDefined()
  })
})

describe('a queued event creation', () => {
  it('drops its optimistic row too', async () => {
    await db.events.put({
      accountId: ACC,
      id: 'local-3',
      calendarIds: ['c1'],
      payload: sealPlain({ id: 'local-3' } as never),
    })

    await run({ kind: 'event.create', event: { id: 'local-3' }, tempId: 'local-3' })

    expect(await db.events.get([ACC, 'local-3'])).toBeUndefined()
  })
})

describe('removing something that is already gone', () => {
  it('counts as done rather than failing for ever', async () => {
    /*
     * Deleted on another device, or by an earlier attempt whose answer never
     * arrived. Treating notFound as a failure leaves the action in the queue
     * retrying against something that does not exist.
     */
    answers = { destroyContacts: { type: 'notFound', permanent: true } }
    expect(await run({ kind: 'contact.destroy', ids: ['c1'] })).toBeUndefined()

    answers = { destroyEvents: { type: 'notFound', permanent: true } }
    expect(await run({ kind: 'event.destroy', ids: ['e1'] })).toBeUndefined()
  })

  it('still reports a refusal that is not "gone"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answers = { destroyContacts: { type: 'forbidden', permanent: true } }

    expect(await run({ kind: 'contact.destroy', ids: ['c1'] })).toMatchObject({
      status: 'failed',
      reason: 'forbidden',
    })
  })
})

describe('sending a queued message', () => {
  it('uploads the attachments it still holds locally, then sends', async () => {
    // The blob was kept on the device so composing worked offline; it has to
    // reach the server before the message can reference it.
    await db.blobCache.put({
      accountId: ACC,
      blobId: 'local-blob',
      size: 3,
      lastAccess: 0,
      payload: sealPlain({ type: 'text/plain', data: new Uint8Array([1, 2, 3]) } as never),
    })

    await run({
      kind: 'email.send',
      mail: { attachments: [{ blobId: null, localKey: 'local-blob' }] },
      mailboxIds: { drafts: 'd', sent: 's' },
    })

    expect(calls).toEqual(['uploadBlob', 'sendEmail'])
    // And the local copy is cleaned up, or every sent attachment stays on the
    // device for ever.
    expect(await db.blobCache.get([ACC, 'local-blob'])).toBeUndefined()
  })

  it('does not re-upload an attachment the server already has', async () => {
    await run({
      kind: 'email.send',
      mail: { attachments: [{ blobId: 'already-there', localKey: null }] },
      mailboxIds: { drafts: 'd', sent: 's' },
    })

    expect(calls).toEqual(['sendEmail'])
  })

  it('fails loudly when the attachment is no longer on the device', async () => {
    /*
     * Sending the message without it would deliver a mail whose attachment
     * silently vanished — the sender would never know.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const row = await run({
      kind: 'email.send',
      mail: { attachments: [{ blobId: null, localKey: 'gone' }] },
      mailboxIds: { drafts: 'd', sent: 's' },
    })

    expect(calls).not.toContain('sendEmail')
    expect(row).toMatchObject({ status: 'failed', reason: 'attachmentLost' })
  })
})

describe('an action with no provider for it', () => {
  it('is recorded as such rather than retried against nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('./connections', () => ({ connectionFor: () => Promise.resolve({ mail: null }) }))
    vi.resetModules()
    const { flush: freshFlush } = await import('./outbox')

    await db.outbox.clear()
    await db.outbox.add({
      accountId: ACC,
      kind: 'contact.update',
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain({ kind: 'contact.update', contact: { id: 'c1' } }),
    })
    await freshFlush(ACC)

    expect((await db.outbox.toArray())[0]).toMatchObject({ reason: 'noProvider' })
    vi.doUnmock('./connections')
  })
})

describe('the writes that go to contacts and calendars', () => {
  it('reports a refused update under the type the server gave it', async () => {
    /*
     * The reason is stored in a plain column beside the encrypted payload, so
     * it has to stay a token — a server's description can quote what was
     * submitted, and that would put the contact's own data in the clear.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answers = {
      updateContact: { type: 'invalidProperties', description: 'bad email', permanent: true },
    }

    expect(await run({ kind: 'contact.update', contact: { id: 'c1' } })).toMatchObject({
      status: 'failed',
      reason: 'invalidProperties',
    })
  })

  it('carries an event update and an RSVP through to the calendar', async () => {
    await run({ kind: 'event.update', event: { id: 'e1' } })
    expect(calls).toContain('updateEvent')

    calls.length = 0
    await run({
      kind: 'event.rsvp',
      eventId: 'e1',
      participantId: 'p2',
      status: 'accepted',
    })
    expect(calls).toContain('rsvp')
  })

  it('holds an RSVP the server refused instead of dropping the answer', async () => {
    // The organiser's copy is only updated by the reply reaching them; a
    // silently dropped one leaves the invitation looking unanswered.
    answers = { rsvp: { type: 'serverFail', permanent: false } }

    expect(
      await run({ kind: 'event.rsvp', eventId: 'e1', participantId: 'p2', status: 'accepted' }),
    ).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('records an action with no provider for its kind rather than retrying at nothing', async () => {
    /*
     * A server offering mail but no contacts: retrying forever would keep a
     * queue the user can see from ever draining, with nothing explaining it.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('./connections', () => ({
      connectionFor: () => Promise.resolve({ mail: {}, contacts: null, calendars: null }),
    }))
    vi.resetModules()
    const { flush: freshFlush } = await import('./outbox')

    for (const action of [
      { kind: 'contact.update', contact: { id: 'c1' } },
      { kind: 'event.update', event: { id: 'e1' } },
    ]) {
      await db.outbox.clear()
      await db.outbox.add({
        accountId: ACC,
        kind: action.kind,
        status: 'pending',
        attempts: 0,
        notBefore: 0,
        payload: sealPlain(action),
      })
      await freshFlush(ACC)
      expect((await db.outbox.toArray())[0], action.kind).toMatchObject({ reason: 'noProvider' })
    }
    vi.doUnmock('./connections')
  })
})

describe('a set the server answered in parts', () => {
  it('gives up only when every id failed for good', async () => {
    /*
     * A bulk move of a thousand messages can come back with one id refused
     * for good and the rest merely overloaded. Treating the whole action as
     * permanent would abandon the messages that would have gone through next
     * time.
     */
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    answers = {
      setEmails: {
        updated: [],
        destroyed: [],
        failed: {
          a: { type: 'forbidden', permanent: true },
          b: { type: 'serverFail', permanent: false },
        },
      },
    }

    const mixed = await run({ kind: 'email.update', updates: { a: {}, b: {} } })
    expect(mixed).toMatchObject({ status: 'pending', attempts: 1 })

    answers = {
      setEmails: {
        updated: [],
        destroyed: [],
        failed: { a: { type: 'forbidden', permanent: true } },
      },
    }
    expect(await run({ kind: 'email.update', updates: { a: {} } })).toMatchObject({
      status: 'failed',
      reason: 'forbidden',
    })
  })

  it('is done when the server refused nothing', async () => {
    expect(await run({ kind: 'email.destroy', ids: ['m1'] })).toBeUndefined()
  })
})
