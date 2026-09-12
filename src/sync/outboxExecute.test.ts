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
