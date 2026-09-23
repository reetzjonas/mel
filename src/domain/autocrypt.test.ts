import { describe, expect, it } from 'vitest'
import { autocryptValue, parseAutocrypt } from './autocrypt'

const KEY = 'mDMEZabc+/0123'

describe('parseAutocrypt', () => {
  it('reads the key for the From address, folding whitespace removed', () => {
    expect(
      parseAutocrypt(
        [`addr=Alice@Example.org; prefer-encrypt=mutual; keydata= mDMEZ abc+/\t0123`],
        'alice@example.org',
      ),
    ).toEqual({ addr: 'alice@example.org', mutual: true, keydata: KEY })
    expect(parseAutocrypt([`addr=a@b; keydata=${KEY}==`], 'A@B')).toMatchObject({
      mutual: false,
      keydata: `${KEY}==`,
    })
  })

  it('ignores a header for another address, or none at all', () => {
    expect(parseAutocrypt([`addr=mallory@evil; keydata=${KEY}`], 'alice@example.org')).toBeNull()
    expect(parseAutocrypt(null, 'a@b')).toBeNull()
    expect(parseAutocrypt([`addr=a@b; keydata=${KEY}`], '')).toBeNull()
  })

  it('skips underscore attributes but refuses unknown ones', () => {
    expect(parseAutocrypt([`addr=a@b; _note=x; keydata=${KEY}`], 'a@b')).not.toBeNull()
    expect(parseAutocrypt([`addr=a@b; future=x; keydata=${KEY}`], 'a@b')).toBeNull()
    expect(parseAutocrypt([`addr=a@b; addr=a@b; keydata=${KEY}`], 'a@b')).toBeNull()
    expect(parseAutocrypt([`addr=a@b; junk; keydata=${KEY}`], 'a@b')).toBeNull()
  })

  it('needs both addr and keydata, and keydata that is base64', () => {
    expect(parseAutocrypt(['addr=a@b'], 'a@b')).toBeNull()
    expect(parseAutocrypt([`keydata=${KEY}`], 'a@b')).toBeNull()
    expect(parseAutocrypt(['addr=a@b; keydata=not base64!'], 'a@b')).toBeNull()
  })

  it('treats two valid headers for the sender as none', () => {
    const h = `addr=a@b; keydata=${KEY}`
    expect(parseAutocrypt([h, h], 'a@b')).toBeNull()
    // One for someone else beside it does not count against it.
    expect(parseAutocrypt([h, `addr=c@d; keydata=${KEY}`], 'a@b')).not.toBeNull()
  })
})

describe('autocryptValue', () => {
  it('cuts the key where the header may fold, and reads back', () => {
    const keydata = 'A'.repeat(200)
    const value = autocryptValue('a@b', keydata, '\r\n ')
    expect(value.startsWith(' addr=a@b; keydata=\r\n ')).toBe(true)
    for (const line of value.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78)
    expect(parseAutocrypt([value.replace(/\r\n/g, '')], 'a@b')?.keydata).toBe(keydata)
    expect(autocryptValue('a@b', keydata, ' ')).not.toContain('\n')
  })
})
