import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { AddressBook } from '../../domain/contact'
import type { Contact } from '../../domain/contact'
import { db } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { useContact, useContacts, useDefaultAddressBookId } from './hooks'

const ACC = 'acc'

const contact = (id: string, over: Partial<Contact> = {}): Contact =>
  ({
    id,
    fullName: id,
    given: '',
    surname: '',
    organization: '',
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    note: '',
    memberUids: [],
    addressBookIds: { ab: true },
    ...over,
  }) as unknown as Contact

async function store(c: Contact, sortKey = c.id.toLowerCase()) {
  await db.contacts.put({
    accountId: ACC,
    id: c.id,
    addressBookIds: ['ab'],
    sortKey,
    payload: sealPlain(c),
  })
}

beforeEach(async () => {
  await db.contacts.where('accountId').equals(ACC).delete()
  await db.addressBooks.where('accountId').equals(ACC).delete()
})

describe('the contact list', () => {
  it('sorts by the name on screen, not by the stored key', async () => {
    /*
     * The sortKey column can predate the display-name ordering, and a card
     * whose name was edited keeps the old one until it is written again. The
     * list has to match what it is actually showing, or the letter headings
     * file a card under a letter its row does not start with.
     */
    await store(contact('Zuse'), 'aaa-stale')
    await store(contact('Ada'), 'zzz-stale')

    const { result } = renderHook(() => useContacts(ACC))

    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current!.map((c) => c.fullName)).toEqual(['Ada', 'Zuse'])
  })

  it('sorts the way the reader’s language does, ignoring case and accents', async () => {
    // A plain code-point sort puts "Ärger" after "Zuse" and every capital
    // before every lowercase letter.
    await store(contact('zuse'))
    await store(contact('Ärger'))
    await store(contact('apfel'))

    const { result } = renderHook(() => useContacts(ACC))

    await waitFor(() => expect(result.current).toHaveLength(3))
    expect(result.current!.map((c) => c.fullName)).toEqual(['apfel', 'Ärger', 'zuse'])
  })

  it('is empty rather than undefined without an account', async () => {
    const { result } = renderHook(() => useContacts(undefined))
    await waitFor(() => expect(result.current).toEqual([]))
  })
})

describe('a single contact', () => {
  it('comes back by id, and is null when there is none', async () => {
    await store(contact('Ada'))

    const { result } = renderHook(() => useContact(ACC, 'Ada'))
    await waitFor(() => expect(result.current).toMatchObject({ fullName: 'Ada' }))

    const missing = renderHook(() => useContact(ACC, 'nobody'))
    // Null, not undefined: the detail screen tells "not found" from "still
    // loading" by exactly this.
    await waitFor(() => expect(missing.result.current).toBeNull())
  })
})

describe('where a new contact goes', () => {
  const book = (id: string, isDefault: boolean) =>
    db.addressBooks.put({
      accountId: ACC,
      id,
      payload: sealPlain({ id, name: id, isDefault } as AddressBook),
    })

  it('takes the book the server marks as default', async () => {
    await book('first', false)
    await book('preferred', true)

    const { result } = renderHook(() => useDefaultAddressBookId(ACC))

    await waitFor(() => expect(result.current).toBe('preferred'))
  })

  it('falls back to whichever book exists when none is marked', async () => {
    // Some servers mark none. Answering nothing would leave the new-contact
    // form with nowhere to save to.
    await book('only', false)

    const { result } = renderHook(() => useDefaultAddressBookId(ACC))

    await waitFor(() => expect(result.current).toBe('only'))
  })

  it('is undefined when the account has no address book at all', async () => {
    const { result } = renderHook(() => useDefaultAddressBookId(ACC))
    await waitFor(() => expect(result.current).toBeUndefined())
  })
})

describe('liveness', () => {
  it('picks up a contact added after the hook was mounted', async () => {
    // The list is a live query; without that, a contact created in another
    // tab — or by a sync — never appears until a reload.
    const { result } = renderHook(() => useContacts(ACC))
    await waitFor(() => expect(result.current).toEqual([]))

    await store(contact('Ada'))

    await waitFor(() => expect(result.current).toHaveLength(1))
  })
})
