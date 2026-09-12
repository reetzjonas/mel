import { describe, expect, it } from 'vitest'
import { parseMailto, parseUnsubscribe } from './unsubscribe'

describe('parseUnsubscribe', () => {
  it('sorts the header’s links into the two things that can be done with them', () => {
    expect(
      parseUnsubscribe(['https://example.com/u?id=42', 'mailto:stop@example.com'], null),
    ).toEqual({
      https: ['https://example.com/u?id=42'],
      mailto: ['mailto:stop@example.com'],
      oneClick: false,
    })
  })

  it('takes one-click only on the exact value RFC 8058 defines', () => {
    const urls = ['https://example.com/u']
    expect(parseUnsubscribe(urls, 'List-Unsubscribe=One-Click')?.oneClick).toBe(true)
    // Case and surrounding space are not what makes it a promise.
    expect(parseUnsubscribe(urls, '  list-unsubscribe=ONE-CLICK ')?.oneClick).toBe(true)
    // Anything else is a header we do not understand, so we do not act on it.
    expect(parseUnsubscribe(urls, 'List-Unsubscribe=Something')?.oneClick).toBe(false)
    expect(parseUnsubscribe(urls, null)?.oneClick).toBe(false)
  })

  it('refuses one-click with nothing to post to', () => {
    // The promise is about the https link; a mailto cannot be POSTed.
    const only = parseUnsubscribe(['mailto:stop@example.com'], 'List-Unsubscribe=One-Click')
    expect(only?.oneClick).toBe(false)
  })

  it('drops plain http, which would carry the address in the clear', () => {
    expect(parseUnsubscribe(['http://example.com/u'], null)).toBeNull()
    expect(parseUnsubscribe(['http://example.com/u', 'mailto:s@example.com'], null)).toEqual({
      https: [],
      mailto: ['mailto:s@example.com'],
      oneClick: false,
    })
  })

  it('tolerates the angle brackets and spacing of the raw header form', () => {
    expect(parseUnsubscribe([' <https://example.com/u> '], null)?.https).toEqual([
      'https://example.com/u',
    ])
  })

  it('is null when there is nothing a reader could press', () => {
    // A button that cannot unsubscribe costs a click to discover as much.
    expect(parseUnsubscribe(null, null)).toBeNull()
    expect(parseUnsubscribe([], 'List-Unsubscribe=One-Click')).toBeNull()
    expect(parseUnsubscribe(['not a url', 'javascript:alert(1)'], null)).toBeNull()
  })
})

describe('parseMailto', () => {
  it('pulls out what the composer needs', () => {
    expect(parseMailto('mailto:stop@example.com?subject=unsubscribe%20me&body=please')).toEqual({
      to: 'stop@example.com',
      subject: 'unsubscribe me',
      body: 'please',
    })
  })

  it('falls back to a subject the list will recognise', () => {
    expect(parseMailto('mailto:stop@example.com')).toEqual({
      to: 'stop@example.com',
      subject: 'Unsubscribe',
      body: '',
    })
  })

  it('is null without an address to write to', () => {
    expect(parseMailto('mailto:?subject=stop')).toBeNull()
    expect(parseMailto('https://example.com/u')).toBeNull()
  })
})
