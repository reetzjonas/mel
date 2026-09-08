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

  it('keeps the raw message for the tooltip', () => {
    expect(classifyConnectionError(new TypeError('Failed to fetch')).detail).toBe('Failed to fetch')
  })
})
