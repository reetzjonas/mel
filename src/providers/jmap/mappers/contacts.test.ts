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
    expect(out['name']).toBeUndefined()
  })
})
