import { describe, expect, it } from 'vitest'
import {
  attachmentsOf,
  decodeDataUri,
  embeddedLink,
  fileLink,
  newLinkId,
  toLinks,
  withLink,
  withoutLink,
} from './attachments'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('attachmentsOf', () => {
  it('reads nothing from an event without links', () => {
    expect(attachmentsOf(undefined)).toEqual([])
    expect(attachmentsOf({})).toEqual([])
  })

  it('tells embedded, file and web attachments apart', () => {
    const out = attachmentsOf({
      a: { rel: 'enclosure', href: 'data:text/plain;base64,aGk=', title: 'hi.txt', size: 2 },
      b: { rel: 'enclosure', href: 'https://x/dl', blobId: 'B1', title: 'plan.pdf' },
      c: { rel: 'enclosure', href: 'https://example.com/agenda.pdf' },
    })
    expect(out.map((a) => [a.id, a.source, a.name])).toEqual([
      ['a', 'embedded', 'hi.txt'],
      ['b', 'file', 'plan.pdf'],
      ['c', 'web', 'agenda.pdf'],
    ])
    expect(out[1]!.blobId).toBe('B1')
    expect(out[0]!.size).toBe(2)
  })

  it('ignores links that are not attachments', () => {
    expect(attachmentsOf({ a: { rel: 'describedby', href: 'https://example.com' } })).toEqual([])
    expect(attachmentsOf({ a: { href: 'https://example.com' } })).toEqual([])
  })

  it('does not offer a scheme it would not open', () => {
    expect(attachmentsOf({ a: { rel: 'enclosure', href: 'javascript:alert(1)' } })).toEqual([])
    expect(attachmentsOf({ a: { rel: 'enclosure', href: 'ftp://host/file' } })).toEqual([])
    expect(attachmentsOf({ a: { rel: 'enclosure' } })).toEqual([])
  })

  it('falls back to a generic type and no size', () => {
    const [a] = attachmentsOf({ a: { rel: 'enclosure', href: 'https://x/y' } })
    expect(a!.contentType).toBe('application/octet-stream')
    expect(a!.size).toBeNull()
  })

  it('names an unnamed link after the end of its path', () => {
    const [a] = attachmentsOf({ a: { rel: 'enclosure', href: 'https://x/a/My%20Plan.pdf?v=2' } })
    expect(a!.name).toBe('My Plan.pdf')
  })
})

describe('embedded attachments', () => {
  it('round-trip through a data URI', () => {
    const link = embeddedLink('note.txt', 'text/plain', bytes('Grüße'))
    expect(link.size).toBe(bytes('Grüße').length)
    const [a] = attachmentsOf({ k: link })
    expect(a!.source).toBe('embedded')
    const decoded = decodeDataUri(a!.href)!
    expect(decoded.type).toBe('text/plain')
    expect(new TextDecoder().decode(decoded.bytes)).toBe('Grüße')
  })

  it('encode a file bigger than one slice without overflowing', () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251)
    const decoded = decodeDataUri(embeddedLink('b.bin', 'application/octet-stream', big).href)!
    expect(decoded.bytes).toEqual(big)
  })
})

describe('decodeDataUri', () => {
  it('reads a percent-encoded URI', () => {
    const d = decodeDataUri('data:text/plain,hello%20world')!
    expect(new TextDecoder().decode(d.bytes)).toBe('hello world')
  })

  it('defaults the type', () => {
    expect(decodeDataUri('data:,x')!.type).toBe('text/plain')
  })

  it('gives up on what is not a data URI or is malformed', () => {
    expect(decodeDataUri('https://example.com')).toBeNull()
    expect(decodeDataUri('data:text/plain;base64,%%%')).toBeNull()
  })
})

describe('fileLink', () => {
  it('carries an href, because a link with only a blob id is dropped by the server', () => {
    const link = fileLink({
      name: 'plan.pdf',
      contentType: 'application/pdf',
      size: 10,
      blobId: 'B1',
      href: 'https://host/download/B1',
    })
    expect(link).toMatchObject({ rel: 'enclosure', blobId: 'B1', href: 'https://host/download/B1' })
    expect(attachmentsOf({ k: link })[0]!.source).toBe('file')
  })

  it('leaves the size out when unknown', () => {
    const link = fileLink({
      name: 'a',
      contentType: 't',
      size: null,
      blobId: 'B',
      href: 'https://h',
    })
    expect('size' in link).toBe(false)
  })
})

describe('editing the map', () => {
  it('adds and removes one entry and leaves the rest alone', () => {
    const other = { rel: 'describedby', href: 'https://example.com', custom: 1 }
    const added = withLink({ o: other }, 'n', { rel: 'enclosure', href: 'https://x' })
    expect(Object.keys(added)).toEqual(['o', 'n'])
    expect(withoutLink(added, 'n')).toEqual({ o: other })
  })

  it('does not modify the map it was given', () => {
    const before = { a: { rel: 'enclosure', href: 'https://x' } }
    withLink(before, 'b', {})
    withoutLink(before, 'a')
    expect(Object.keys(before)).toEqual(['a'])
  })

  it('makes a key that is not taken', () => {
    const taken = newLinkId(undefined)
    expect(newLinkId({ [taken]: {} })).not.toBe(taken)
  })
})

describe('toLinks', () => {
  it('keeps objects and drops everything else', () => {
    expect(toLinks({ a: { href: 'x' }, b: 'no', c: null })).toEqual({ a: { href: 'x' } })
    expect(toLinks(null)).toEqual({})
  })
})
