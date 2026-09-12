import { describe, expect, it } from 'vitest'
import { classifyConnectionError, isOpaqueNetworkFailure } from './netError'

describe('classifyConnectionError', () => {
  it('recognises the opaque failure browsers use for CORS and friends', () => {
    // Chrome, Firefox and Safari each word it differently.
    for (const msg of ['Failed to fetch', 'NetworkError when attempting to fetch', 'Load failed']) {
      expect(isOpaqueNetworkFailure(new TypeError(msg))).toBe(true)
      expect(classifyConnectionError(new TypeError(msg)).kind).toBe('unreachable')
    }
  })

  it('does not mistake a server response for a connection failure', () => {
    expect(classifyConnectionError(new Error('HTTP 404')).kind).toBe('other')
    expect(isOpaqueNetworkFailure(new Error('HTTP 500'))).toBe(false)
  })

  it('picks out an auth rejection', () => {
    const e = Object.assign(new Error('Sign-in failed'), { kind: 'auth' })
    expect(classifyConnectionError(e).kind).toBe('auth')
  })

  it('separates a throttled server from an unreachable one', () => {
    /*
     * The opposite of unreachable: it answered, and said when to come back.
     * Folding the two together put "Server unreachable" in the sidebar of a
     * server that was replying to every request, which sends whoever reads it
     * looking at DNS and certificates.
     */
    const e = Object.assign(new Error('HTTP 429'), { kind: 'ratelimit' })

    expect(classifyConnectionError(e).kind).toBe('ratelimit')
    expect(isOpaqueNetworkFailure(e)).toBe(false)
  })

  it('keeps the raw message for the tooltip', () => {
    expect(classifyConnectionError(new TypeError('Failed to fetch')).detail).toBe('Failed to fetch')
  })
})
