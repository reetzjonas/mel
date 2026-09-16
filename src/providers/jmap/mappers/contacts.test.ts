import { describe, expect, it } from 'vitest'
import { fromContact, toContact, type JmapContactCard } from './contacts'

const card: JmapContactCard = {
  id: 'c1',
  addressBookIds: { b: true },
  '@type': 'Card',
  version: '1.0',
  kind: 'individual',
  name: {
    full: 'Carla Muster',
    components: [
      { kind: 'given', value: 'Carla' },
      { kind: 'surname', value: 'Muster' },
    ],
  },
  organizations: { o0: { name: 'ACME GmbH' } },
  emails: { e0: { address: 'carla@example.com', contexts: { work: true } } },
  phones: { p0: { number: '+49 30 123456' } },
  addresses: { a0: { full: 'Musterstr. 1, 10115 Berlin' } },
  notes: { n0: { note: 'VIP' } },
}

describe('JSContact mapper', () => {
  it('maps a ContactCard to the domain contact', () => {
    const c = toContact(card)
    expect(c.id).toBe('c1')
    expect(c.given).toBe('Carla')
    expect(c.surname).toBe('Muster')
    expect(c.fullName).toBe('Carla Muster')
    expect(c.organization).toBe('ACME GmbH')
    expect(c.emails).toEqual([{ value: 'carla@example.com', label: 'work' }])
    expect(c.phones).toEqual([{ value: '+49 30 123456', label: null }])
    expect(c.addresses).toEqual([{ full: 'Musterstr. 1, 10115 Berlin', label: null }])
    expect(c.note).toBe('VIP')
  })

  it('round-trips through fromContact with the essential fields intact', () => {
    const c = toContact(card)
    const out = fromContact(c) as Record<string, any>
    expect(out['@type']).toBe('Card')
    expect(out['name'].components).toEqual([
      { kind: 'given', value: 'Carla' },
      { kind: 'surname', value: 'Muster' },
    ])
    expect(Object.values(out['emails'])[0]).toEqual({
      address: 'carla@example.com',
      contexts: { work: true },
    })
    expect(Object.values(out['organizations'])[0]).toEqual({ name: 'ACME GmbH' })
    expect(out['addressBookIds']).toEqual({ b: true })
  })

  it('handles cards with only an email address', () => {
    const c = toContact({
      id: 'c2',
      addressBookIds: { b: true },
      emails: { e0: { address: 'x@y.z' } },
    })
    expect(c.given).toBe('')
    expect(c.emails[0]?.value).toBe('x@y.z')
    const out = fromContact(c) as Record<string, unknown>
    // null, not undefined: see the clearing tests below.
    expect(out['name']).toBeNull()
  })
})

describe('clearing a field the card already has', () => {
  /*
   * ContactCard/set takes an update as a patch, so a property left out is one
   * the server keeps untouched. Emitting undefined for an emptied list meant
   * deleting a contact's last email saved without complaint and changed
   * nothing — the address was still there after the next sync.
   */
  it('says null for every field the contact no longer has', () => {
    const empty = toContact({ id: 'c3', addressBookIds: { b: true } })
    const out = fromContact(empty) as Record<string, unknown>
    for (const field of [
      'name',
      'nicknames',
      'organizations',
      'titles',
      'emails',
      'phones',
      'addresses',
      'links',
      'onlineServices',
      'keywords',
      'notes',
    ])
      expect(out[field], field).toBeNull()
  })

  it('still sends the values a contact does have', () => {
    const c = toContact(card)
    const out = fromContact(c) as Record<string, unknown>
    expect(out['emails']).not.toBeNull()
    expect(out['phones']).not.toBeNull()
  })
})

describe('handles on other services', () => {
  const withService: JmapContactCard = {
    id: 'c4',
    addressBookIds: { b: true },
    onlineServices: {
      s0: { service: 'Mastodon', user: '@carla@chaos.social', uri: 'https://chaos.social/@carla' },
      s1: { service: 'Matrix', user: '@carla:example.org' },
      s2: { uri: 'https://signal.me/#p/x' },
      s3: { service: 'Ghost' },
    },
  }

  it('keeps the service, the handle and the link apart', () => {
    const c = toContact(withService)
    expect(c.onlineServices[0]).toEqual({
      service: 'Mastodon',
      user: '@carla@chaos.social',
      uri: 'https://chaos.social/@carla',
    })
    expect(c.onlineServices[1]).toEqual({ service: 'Matrix', user: '@carla:example.org', uri: '' })
    expect(c.onlineServices[2]).toEqual({ service: '', user: '', uri: 'https://signal.me/#p/x' })
  })

  // An entry naming a service and nothing else says nothing at all.
  it('drops an entry with neither handle nor link', () => {
    expect(toContact(withService).onlineServices).toHaveLength(3)
  })

  it('writes back the link it was given rather than losing it', () => {
    const out = fromContact(toContact(withService)) as Record<string, unknown>
    const services = Object.values(out['onlineServices'] as Record<string, unknown>)
    expect(services[0]).toEqual({
      '@type': 'OnlineService',
      service: 'Mastodon',
      user: '@carla@chaos.social',
      uri: 'https://chaos.social/@carla',
    })
  })

  /*
   * Stalwart stores no OnlineService without a uri and says nothing about it —
   * the card saves, reports success, and comes back a field short. A handle
   * with no link therefore travels as its own uri.
   */
  it('never writes an entry without a uri', () => {
    const out = fromContact(toContact(withService)) as Record<string, unknown>
    const services = Object.values(
      out['onlineServices'] as Record<string, Record<string, unknown>>,
    )
    for (const s of services) expect(s['uri']).toBeTruthy()
    expect(services[1]).toEqual({
      '@type': 'OnlineService',
      service: 'Matrix',
      user: '@carla:example.org',
      uri: '@carla:example.org',
    })
  })
})

describe('tags on a card', () => {
  it('reads the set as a list, ignoring the ones switched off', () => {
    const c = toContact({
      id: 'c5',
      addressBookIds: { b: true },
      keywords: { friend: true, 'ski-club': true, former: false },
    })
    expect(c.keywords).toEqual(['friend', 'ski-club'])
  })

  it('writes the list back as a set', () => {
    const c = toContact({ id: 'c6', addressBookIds: { b: true } })
    const out = fromContact({ ...c, keywords: ['friend', 'ski-club'] }) as Record<string, unknown>
    expect(out['keywords']).toEqual({ friend: true, 'ski-club': true })
  })
})
