// @vitest-environment node
// postal-mime is the reference parser here, and it wants one realm's
// Uint8Array; under jsdom TextEncoder hands out another's.
import PostalMime from 'postal-mime'
import { describe, expect, it } from 'vitest'
import {
  bodyEntity,
  encodeWords,
  encryptedEntity,
  formatAddress,
  mailDate,
  message,
  signedEntity,
} from './mimeBuild'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: ArrayBuffer | Uint8Array | string) =>
  typeof b === 'string' ? b : new TextDecoder().decode(b)

const headers = {
  from: { name: 'Jörg Müller', email: 'joerg@example.com' },
  to: [
    { name: 'Lovelace, Ada', email: 'ada@example.com' },
    { name: null, email: 'bob@example.com' },
  ],
  cc: [{ name: 'Carol', email: 'carol@example.com' }],
  subject: 'Grüße aus dem Büro — ein recht langer Betreff, der gefaltet werden muss',
  date: new Date('2026-09-23T10:00:00Z'),
  messageId: 'abc@example.com',
  inReplyTo: ['parent@example.com'],
  references: ['root@example.com', 'parent@example.com'],
}

describe('header encoding', () => {
  it('leaves ASCII alone and encodes the rest without splitting a character', () => {
    expect(encodeWords('Hello')).toBe('Hello')
    const encoded = encodeWords('€'.repeat(40))
    for (const word of encoded.split('\r\n ')) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
      expect(word.length).toBeLessThan(78)
    }
  })

  it('quotes or encodes display names as needed', () => {
    expect(formatAddress({ name: null, email: 'a@b' })).toBe('a@b')
    expect(formatAddress({ name: 'Ada King', email: 'a@b' })).toBe('Ada King <a@b>')
    expect(formatAddress({ name: 'King, "Ada"', email: 'a@b' })).toBe('"King, \\"Ada\\"" <a@b>')
    expect(formatAddress({ name: 'Jörg', email: 'a@b' })).toMatch(/^=\?UTF-8\?B\?.+\?= <a@b>$/)
  })

  it('writes a numeric zone', () => {
    expect(mailDate(new Date('2026-01-02T03:04:05Z'))).toBe('Fri, 02 Jan 2026 03:04:05 +0000')
  })
})

describe('a message round-trips through a real parser', () => {
  it('headers, text, HTML with an inline picture, and a file with a non-ASCII name', async () => {
    const picture = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const raw = message(
      headers,
      bodyEntity({
        text: 'Hallo Ada,\nwie geht’s?',
        html: '<p>Hallo <b>Ada</b></p><img src="cid:pic1">',
        attachments: [
          { name: 'bild.png', type: 'image/png', data: picture, cid: 'pic1' },
          { name: 'Übersicht 2026.pdf', type: 'application/pdf', data: enc('%PDF-1.4 x') },
        ],
      }),
    )
    // 7-bit clean, CRLF only: what a signature can be computed over.
    expect([...raw].every((c) => c.charCodeAt(0) < 128)).toBe(true)
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)

    const mail = await PostalMime.parse(raw)
    expect(mail.subject).toBe(headers.subject)
    expect(mail.from).toMatchObject({ name: 'Jörg Müller', address: 'joerg@example.com' })
    expect(mail.to).toMatchObject([
      { name: 'Lovelace, Ada', address: 'ada@example.com' },
      { address: 'bob@example.com' },
    ])
    expect(mail.cc).toMatchObject([{ name: 'Carol', address: 'carol@example.com' }])
    expect(mail.messageId).toBe('<abc@example.com>')
    expect(mail.inReplyTo).toBe('<parent@example.com>')
    expect(mail.references).toBe('<root@example.com> <parent@example.com>')
    expect(mail.text?.trim()).toBe('Hallo Ada,\nwie geht’s?')
    expect(mail.html).toContain('<b>Ada</b>')
    const [pic, pdf] = mail.attachments
    expect(pic).toMatchObject({ mimeType: 'image/png', contentId: '<pic1>', disposition: 'inline' })
    expect(new Uint8Array(pic!.content as ArrayBuffer)).toEqual(picture)
    expect(pdf).toMatchObject({ filename: 'Übersicht 2026.pdf', disposition: 'attachment' })
    expect(dec(pdf!.content)).toBe('%PDF-1.4 x')
  })

  it('plain text alone is a single part, and an HTML body without pictures has no related part', async () => {
    const plain = bodyEntity({ text: 'just text', html: null, attachments: [] })
    expect(plain).toMatch(/^Content-Type: text\/plain; charset=utf-8\r\n/)
    const rich = bodyEntity({ text: 't', html: '<p>h</p>', attachments: [] })
    expect(rich).toMatch(/^Content-Type: multipart\/alternative;/)
    expect(rich).not.toContain('multipart/related')
    // A cid-tagged file on a plain-text message is just a file.
    const mixed = bodyEntity({
      text: 't',
      html: null,
      attachments: [{ name: 'a.png', type: 'image/png', data: new Uint8Array([1]), cid: 'x' }],
    })
    expect(mixed).toMatch(/^Content-Type: multipart\/mixed;/)
    expect(mixed).toContain('Content-Disposition: attachment')
  })

  it('leaves out Cc, In-Reply-To and References when empty, and never writes Bcc', () => {
    const raw = message(
      { ...headers, cc: [], inReplyTo: null, references: [] },
      bodyEntity({ text: 'x', html: null, attachments: [] }),
    )
    expect(raw).not.toMatch(/^(Cc|In-Reply-To|References|Bcc):/m)
  })
})

describe('PGP/MIME wrappers', () => {
  it('signed: the entity is placed byte for byte, followed by the signature', async () => {
    const entity = bodyEntity({ text: 'signed words', html: null, attachments: [] })
    const sig = '-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n'
    const wrapped = signedEntity(entity, sig, 'pgp-sha256')
    expect(wrapped).toMatch(
      /^Content-Type: multipart\/signed; boundary="mel-[0-9a-f]+"; micalg=pgp-sha256; protocol="application\/pgp-signature"/,
    )
    expect(wrapped).toContain(`\r\n${entity}\r\n--mel-`)
    expect(wrapped).toContain(
      '-----BEGIN PGP SIGNATURE-----\r\n\r\nabc\r\n-----END PGP SIGNATURE-----\r\n--mel-',
    )
  })

  it('encrypted: version part first, then the ciphertext', async () => {
    const armored = '-----BEGIN PGP MESSAGE-----\n\nxyz\n-----END PGP MESSAGE-----'
    const raw = message(headers, encryptedEntity(armored))
    const mail = await PostalMime.parse(raw)
    expect(mail.attachments.map((a) => a.mimeType)).toEqual([
      'application/pgp-encrypted',
      'application/octet-stream',
    ])
    expect(dec(mail.attachments[0]!.content)).toContain('Version: 1')
    expect(dec(mail.attachments[1]!.content)).toContain('-----BEGIN PGP MESSAGE-----')
  })
})
