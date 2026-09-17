import { describe, expect, it } from 'vitest'
import { contactSortKey, displayName, storedContact, type Contact } from './contact'

const contact = (over: Partial<Contact> = {}): Contact =>
  ({
    id: 'c1',
    fullName: '',
    given: '',
    surname: '',
    organization: '',
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    note: '',
    memberUids: [],
    addressBookIds: {},
    ...over,
  }) as unknown as Contact

describe('displayName', () => {
  /*
   * The fallback chain is what the contacts list shows, and a card can be
   * missing almost everything — a vCard with nothing but an address is
   * ordinary. Each rung is pinned so a reorder cannot silently start showing
   * an email address where a name used to be.
   */
  it('prefers the name the card states outright', () => {
    expect(displayName(contact({ fullName: 'Ada Lovelace', given: 'Augusta' }))).toBe(
      'Ada Lovelace',
    )
  })

  it('falls back to given plus surname, given name first', () => {
    expect(displayName(contact({ given: 'Ada', surname: 'Lovelace' }))).toBe('Ada Lovelace')
    // Either half on its own still beats dropping to the organisation.
    expect(displayName(contact({ surname: 'Lovelace', organization: 'Analytical' }))).toBe(
      'Lovelace',
    )
  })

  it('then the organisation, then an address', () => {
    expect(displayName(contact({ organization: 'Analytical Engines' }))).toBe('Analytical Engines')
    expect(displayName(contact({ emails: [{ label: null, value: 'ada@example.com' }] }))).toBe(
      'ada@example.com',
    )
  })

  it('never comes back empty, so no row renders as a blank line', () => {
    expect(displayName(contact())).toBe('—')
  })
})

describe('contactSortKey', () => {
  it('sorts on exactly what is displayed, so the letter headings agree', () => {
    // The list groups by first letter. A key derived from a different field
    // would file a card under a letter its own row does not start with.
    const c = contact({ fullName: 'Ada Lovelace', emails: [{ label: null, value: 'z@b.c' }] })
    expect(contactSortKey(c)).toBe(displayName(c).toLowerCase())
  })

  it('is case-insensitive, so casing cannot split the alphabet in two', () => {
    expect(contactSortKey(contact({ fullName: 'ada' }))).toBe(
      contactSortKey(contact({ fullName: 'ADA' })),
    )
  })
})

describe('storedContact', () => {
  /*
   * A row written before a field existed does not have it, and nothing
   * migrates it — the model grew handles, tags, a picture and a birthday
   * after cards were already on disk. Reading one of those as a string or an
   * array is what took the whole calendar down: it builds a birthday event
   * out of every card, so one old row without `birthday` threw on `.trim()`
   * and the screen went to the error boundary.
   */
  it('fills in what a card written by an older version has no key for', () => {
    const old = { id: 'c1', addressBookIds: { ab: true }, fullName: 'Ada' } as unknown as Contact

    const filled = storedContact(old)

    expect(filled.birthday).toBe('')
    expect(filled.photo).toBe('')
    expect(filled.keywords).toEqual([])
    expect(filled.onlineServices).toEqual([])
    expect(filled.emails).toEqual([])
    expect(displayName(filled)).toBe('Ada')
  })

  it('leaves everything the card does carry alone', () => {
    const c = contact({
      fullName: 'Ada',
      birthday: '--12-10',
      keywords: ['friend'],
      emails: [{ label: null, value: 'ada@example.com' }],
    })

    expect(storedContact(c)).toMatchObject({
      fullName: 'Ada',
      birthday: '--12-10',
      keywords: ['friend'],
      emails: [{ label: null, value: 'ada@example.com' }],
    })
  })
})
