import { describe, expect, it } from 'vitest'
import { mapHref, profileHref, telHref } from './links'

describe('dialling a stored number', () => {
  it('drops the separators that only help a reader', () => {
    expect(telHref('(030) 12 34-56')).toBe('tel:030123456')
  })

  it('keeps a leading plus, which is not decoration', () => {
    expect(telHref('+49 30 123456')).toBe('tel:+4930123456')
  })

  // A phone field is free text, and people put things in it that are not
  // numbers. A link to `tel:` with nothing after it opens nothing.
  it('refuses a value with no digits in it', () => {
    expect(telHref('ask Ines')).toBeNull()
    expect(telHref('   ')).toBeNull()
  })

  it('does not invent a plus in the middle of a number', () => {
    expect(telHref('030 1234+56')).toBe('tel:030123456')
  })
})

describe('finding a stored address on a map', () => {
  it('searches for the address as one line', () => {
    expect(mapHref('Hauptstr. 1\n10115 Berlin')).toBe(
      'https://www.openstreetmap.org/search?query=Hauptstr.%201%2C%2010115%20Berlin',
    )
  })

  it('escapes what would otherwise break the query', () => {
    expect(mapHref('A&B Str. 1')).toContain('A%26B')
  })

  it('has nothing to search for in an empty address', () => {
    expect(mapHref('')).toBeNull()
    expect(mapHref('\n  \n')).toBeNull()
  })
})

describe('opening a handle on another service', () => {
  it('links a uri that has a scheme', () => {
    expect(profileHref('https://chaos.social/@erika')).toBe('https://chaos.social/@erika')
    expect(profileHref('xmpp:erika@example.org')).toBe('xmpp:erika@example.org')
  })

  // The uri field doubles as the store for a bare handle, because a card
  // without one is dropped by the server — so it is not always a link.
  it('refuses a handle that only looks like an address', () => {
    expect(profileHref('@erika@chaos.social')).toBeNull()
    expect(profileHref('erika:matrix')).toBe('erika:matrix')
  })
})
