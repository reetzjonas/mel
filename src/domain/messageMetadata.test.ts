import { describe, expect, it } from 'vitest'
import {
  authResults,
  deliveryPath,
  emlFileName,
  headerValue,
  headerValues,
  headersAsText,
  notableHeaders,
  unfoldHeader,
  type RawHeader,
} from './messageMetadata'

/** Verbatim from the dev Stalwart, folding and leading spaces included. */
const stalwart: RawHeader[] = [
  { name: 'Delivered-To', value: ' alice@localhost' },
  {
    name: 'Received',
    value:
      ' from seed.mel.dev (pop-os [172.19.0.1])\r\n\tby localhost (Stalwart SMTP) with ESMTP id 48F8FC996C00000;\r\n\tWed, 9 Sep 2026 20:57:54 +0000',
  },
  {
    name: 'Authentication-Results',
    value:
      ' localhost;\r\n\tspf=none (localhost: no SPF records found for postmaster@seed.mel.dev) smtp.helo=seed.mel.dev;\r\n\tspf=none (localhost: no SPF records found for bob@localhost) smtp.mailfrom=bob@localhost;\r\n\tiprev=pass policy.iprev=172.19.0.1;\r\n\tdmarc=none header.from=localhost policy.dmarc=none',
  },
  {
    name: 'Received-SPF',
    value:
      ' none (localhost: no SPF records found for bob@localhost)\r\n\treceiver=localhost; client-ip=172.19.0.1; envelope-from="bob@localhost"; helo=seed.mel.dev;',
  },
  { name: 'Return-Path', value: ' <bob@localhost>' },
  { name: 'From', value: ' bob@localhost' },
  { name: 'Subject', value: ' Willkommen bei mel' },
  { name: 'Message-ID', value: ' <302163891@seed.local>' },
]

describe('unfoldHeader', () => {
  it('joins continuation lines and drops the leading space', () => {
    expect(unfoldHeader(' one\r\n\ttwo\r\n three')).toBe('one two three')
  })
})

describe('headerValue', () => {
  it('matches the name case-insensitively and unfolds', () => {
    expect(headerValue(stalwart, 'message-id')).toBe('<302163891@seed.local>')
    expect(headerValue(stalwart, 'X-Absent')).toBeNull()
  })

  it('returns every value of a repeated header', () => {
    expect(headerValues(stalwart, 'Received')).toHaveLength(1)
    expect(headerValues(stalwart, 'Received')[0]).toContain('by localhost')
  })
})

describe('deliveryPath', () => {
  it('reads host, IP, protocol and time out of a Received line', () => {
    expect(deliveryPath(stalwart)).toEqual([
      {
        from: 'seed.mel.dev',
        ip: '172.19.0.1',
        by: 'localhost',
        protocol: 'ESMTP',
        at: 'Wed, 9 Sep 2026 20:57:54 +0000',
        raw: expect.stringContaining('from seed.mel.dev'),
      },
    ])
  })

  it('lists hops in transit order, not header order', () => {
    // Received headers are prepended by each hop, so the file order is the
    // reverse of the journey — showing it unreversed reads as if mail flowed
    // from your own server outwards.
    const headers: RawHeader[] = [
      { name: 'Received', value: 'from relay.example.net by mx.example.org with ESMTPS; Sun' },
      { name: 'Received', value: 'from origin.example.com by relay.example.net with ESMTP; Sat' },
    ]
    expect(deliveryPath(headers).map((hop) => hop.from)).toEqual([
      'origin.example.com',
      'relay.example.net',
    ])
  })

  it('ignores keywords inside comments and handles a missing timestamp', () => {
    const headers: RawHeader[] = [
      { name: 'Received', value: '(from userid 1000) by build.example.com (8.15.2) id x42' },
    ]
    expect(deliveryPath(headers)[0]).toMatchObject({
      from: null,
      by: 'build.example.com',
      at: null,
    })
  })

  it('is empty for a message with no Received header at all', () => {
    expect(deliveryPath([{ name: 'Subject', value: 'local draft' }])).toEqual([])
  })
})

describe('authResults', () => {
  it('reports one verdict per clause, each with the identity it applies to', () => {
    // Two spf=none: the HELO name and the envelope sender are checked apart,
    // and side by side without the identity they read as a contradiction.
    expect(authResults(stalwart)).toEqual([
      { method: 'spf', result: 'none', identity: 'smtp.helo=seed.mel.dev' },
      { method: 'spf', result: 'none', identity: 'smtp.mailfrom=bob@localhost' },
      { method: 'iprev', result: 'pass', identity: 'policy.iprev=172.19.0.1' },
      { method: 'dmarc', result: 'none', identity: 'header.from=localhost' },
    ])
  })

  it('does not read the published policy as a second verdict', () => {
    // policy.dmarc is what the sender *asked* recipients to do on failure, not
    // what this server decided; matching it produced a bogus "dmarc quarantine"
    // beside the real "dmarc pass".
    const headers: RawHeader[] = [
      {
        name: 'Authentication-Results',
        value:
          'mx.example.org; dkim=pass header.d=example.com; dmarc=pass header.from=example.com policy.dmarc=quarantine',
      },
    ]
    expect(authResults(headers)).toEqual([
      { method: 'dkim', result: 'pass', identity: 'header.d=example.com' },
      { method: 'dmarc', result: 'pass', identity: 'header.from=example.com' },
    ])
  })

  it('folds a verdict repeated for the same identity', () => {
    const headers: RawHeader[] = [
      { name: 'Authentication-Results', value: 'mx.example.org; dkim=pass header.d=a.example' },
      { name: 'Authentication-Results', value: 'mx2.example.org; dkim=pass header.d=a.example' },
    ]
    expect(authResults(headers)).toHaveLength(1)
  })

  it('keeps differing verdicts for the same method', () => {
    const headers: RawHeader[] = [
      {
        name: 'Authentication-Results',
        value: 'mx.example.org; spf=pass smtp.helo=a; spf=fail smtp.mailfrom=b; dkim=pass',
      },
    ]
    expect(authResults(headers)).toEqual([
      { method: 'spf', result: 'pass', identity: 'smtp.helo=a' },
      { method: 'spf', result: 'fail', identity: 'smtp.mailfrom=b' },
      { method: 'dkim', result: 'pass', identity: null },
    ])
  })

  it('falls back to Received-SPF only when SPF was not reported', () => {
    const headers: RawHeader[] = [
      { name: 'Received-SPF', value: 'pass (example.org: good) envelope-from="x@example.org"' },
    ]
    expect(authResults(headers)).toEqual([
      { method: 'spf', result: 'pass', identity: 'envelope-from=x@example.org' },
    ])
    // The Stalwart sample reports SPF itself, so its Received-SPF adds nothing.
    expect(
      authResults(stalwart).every((r) => r.identity?.startsWith('envelope-from') !== true),
    ).toBe(true)
  })

  it('does not read a verdict out of an explanatory comment', () => {
    const headers: RawHeader[] = [
      {
        name: 'Authentication-Results',
        value: 'mx.example.org; dkim=pass (the sender claims spf=pass, which it is not)',
      },
    ]
    expect(authResults(headers)).toEqual([{ method: 'dkim', result: 'pass', identity: null }])
  })
})

describe('notableHeaders', () => {
  it('picks the named ones that are present, in display order', () => {
    expect(notableHeaders(stalwart)).toEqual([
      { name: 'Message-ID', value: '<302163891@seed.local>' },
      { name: 'Return-Path', value: '<bob@localhost>' },
    ])
  })
})

describe('headersAsText', () => {
  it('writes one unfolded header per line', () => {
    const text = headersAsText(stalwart)
    expect(text.split('\n')[0]).toBe('Delivered-To: alice@localhost')
    expect(text).toContain('Message-ID: <302163891@seed.local>')
    expect(text).not.toContain('\r')
  })
})

describe('emlFileName', () => {
  it('uses the subject', () => {
    expect(emlFileName('Willkommen bei mel')).toBe('Willkommen bei mel.eml')
  })

  it('treats the subject as hostile input', () => {
    // The subject is written by the sender; a download must not be able to
    // name a path, hide itself, or exceed what a filesystem takes.
    // Separators become spaces, then the leading dots go: no path, no dotfile.
    expect(emlFileName('../../etc/passwd')).toBe('.. etc passwd.eml')
    expect(emlFileName('...hidden')).toBe('hidden.eml')
    expect(emlFileName('a\u0000b')).toBe('a b.eml')
    expect(emlFileName('x'.repeat(200))).toBe(`${'x'.repeat(60)}.eml`)
  })

  it('falls back when there is no subject to use', () => {
    expect(emlFileName(null)).toBe('message.eml')
    expect(emlFileName('   ')).toBe('message.eml')
  })
})
