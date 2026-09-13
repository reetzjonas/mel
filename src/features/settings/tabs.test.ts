import { describe, expect, it } from 'vitest'
import { anchorId, isSettingsAnchor, isSettingsTab } from './tabs'

describe('isSettingsTab', () => {
  it('accepts the tabs that exist and nothing else', () => {
    expect(isSettingsTab('mail')).toBe(true)
    expect(isSettingsTab('nonsense')).toBe(false)
    expect(isSettingsTab(undefined)).toBe(false)
  })
})

describe('isSettingsAnchor', () => {
  it('accepts only sections a link may point at', () => {
    /*
     * A closed list rather than any string: `?at=` comes off the address bar,
     * and it ends up in getElementById. An open one would let a link claim to
     * scroll somewhere that does not exist, which fails silently.
     */
    expect(isSettingsAnchor('sieve')).toBe(true)
    expect(isSettingsAnchor('capabilities')).toBe(true)
    expect(isSettingsAnchor('anything-else')).toBe(false)
  })
})

describe('anchorId', () => {
  it('namespaces the id, so it cannot collide with anything else on the page', () => {
    expect(anchorId('sieve')).toBe('settings-sieve')
  })
})
