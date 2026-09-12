import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '../domain/contact'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'

const enqueued: Array<Record<string, unknown>> = []
vi.mock('../sync/outbox', () => ({
  enqueue: (_accountId: string, action: Record<string, unknown>) => {
    enqueued.push(action)
    return Promise.resolve(1)
  },
}))

let createOnServer: () => { id: string | null; failure: unknown } = () => ({
  id: 'server-id',
  failure: null,
})
vi.mock('../sync/connections', () => ({
  connectionFor: () =>
    Promise.resolve({ contacts: { createContact: () => Promise.resolve(createOnServer()) } }),
}))

const { createContact, deleteContact, updateContact } = await import('./contacts')

const ACC = 'acc'

const contact = (over: Partial<Contact> = {}): Omit<Contact, 'id'> =>
  ({
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
  }) as unknown as Omit<Contact, 'id'>

const online = (value: boolean) =>
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })

beforeEach(async () => {
  enqueued.length = 0
  createOnServer = () => ({ id: 'server-id', failure: null })
  online(true)
  await db.contacts.where('accountId').equals(ACC).delete()
})

describe('creating a contact', () => {
  it('asks the server first, so the caller gets the real id to navigate to', async () => {
    // The new contact's screen is opened by id; a temporary one would be a
    // URL that stops existing the moment the sync lands.
    const id = await createContact(ACC, contact())

    expect(id).toBe('server-id')
    expect(enqueued).toEqual([])
    expect(await db.contacts.get([ACC, 'server-id'])).toBeDefined()
  })

  it('keeps the contact and queues it when offline', async () => {
    online(false)

    const id = await createContact(ACC, contact())

    expect(id).toMatch(/^local-/)
    expect(await db.contacts.get([ACC, id])).toBeDefined()
    expect(enqueued[0]).toMatchObject({ kind: 'contact.create', tempId: id })
  })

  it('falls back to the queue when the request fails in a way that may pass', async () => {
    // Losing what someone typed because the network blinked would be the
    // worst possible answer here.
    createOnServer = () => {
      throw Object.assign(new Error('offline'), { transient: true })
    }

    const id = await createContact(ACC, contact())

    expect(id).toMatch(/^local-/)
    expect(enqueued[0]).toMatchObject({ kind: 'contact.create' })
  })

  it('hands a refusal that will not change straight to the caller', async () => {
    // A card the server rejects outright must not sit in the queue being
    // retried for ever; the form has to say so instead.
    createOnServer = () => ({ id: null, failure: { type: 'invalidProperties', permanent: true } })

    await expect(createContact(ACC, contact())).rejects.toThrow('invalidProperties')
    expect(enqueued).toEqual([])
  })
})

describe('editing and removing a contact', () => {
  it('writes locally and queues the change', async () => {
    const full = { ...contact(), id: 'server-id' } as Contact

    await updateContact(ACC, { ...full, fullName: 'Ada L.' })

    const row = await db.contacts.get([ACC, 'server-id'])
    expect(openEnvelope(row!.payload).fullName).toBe('Ada L.')
    expect(enqueued[0]).toMatchObject({ kind: 'contact.update' })
  })

  it('keeps the sort key in step with the name, so the list stays ordered', async () => {
    // The list groups by first letter off this column, not off the payload.
    const full = { ...contact(), id: 'server-id' } as Contact
    await updateContact(ACC, { ...full, fullName: 'Zuse, Konrad' })

    expect((await db.contacts.get([ACC, 'server-id']))!.sortKey).toBe('zuse, konrad')
  })

  it('does not queue an edit to a contact the server has never seen', async () => {
    /*
     * Its creation is still in the queue and carries the whole card, so an
     * update alongside it would be an edit to an id that does not exist yet.
     */
    const local = { ...contact(), id: 'local-abc' } as Contact

    await updateContact(ACC, local)

    expect(enqueued).toEqual([])
    expect(await db.contacts.get([ACC, 'local-abc'])).toBeDefined()
  })

  it('removes a queued-only contact without telling the server about it', async () => {
    const local = { ...contact(), id: 'local-abc' } as Contact
    await updateContact(ACC, local)

    await deleteContact(ACC, 'local-abc')

    expect(await db.contacts.get([ACC, 'local-abc'])).toBeUndefined()
    expect(enqueued).toEqual([])
  })

  it('queues the destroy for one the server does know', async () => {
    await deleteContact(ACC, 'server-id')
    expect(enqueued[0]).toMatchObject({ kind: 'contact.destroy', ids: ['server-id'] })
  })
})
