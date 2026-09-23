import { describe, expect, it } from 'vitest'
import type { EmailBody, EmailBodyPart } from './email'
import {
  canonicalLines,
  encryptedPart,
  formatFingerprint,
  inlineBlock,
  isSignedEntity,
  pgpKind,
  pgpMachinery,
  splitSigned,
} from './pgp'

const part = (type: string, extra: Partial<EmailBodyPart> = {}): EmailBodyPart => ({
  partId: type,
  blobId: `b-${type}`,
  type,
  name: null,
  disposition: null,
  cid: null,
  size: 10,
  ...extra,
})

const body = (extra: Partial<EmailBody> = {}): EmailBody => ({
  emailId: 'e1',
  html: null,
  text: null,
  attachments: [],
  messageId: null,
  references: null,
  ...extra,
})

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

const SIG = '-----BEGIN PGP SIGNATURE-----\r\n\r\nabc\r\n-----END PGP SIGNATURE-----'

describe('pgpKind', () => {
  it('recognises PGP/MIME by its parts, the way the server lists them', () => {
    const encrypted = body({
      attachments: [part('application/pgp-encrypted'), part('application/octet-stream')],
    })
    expect(pgpKind(encrypted)).toBe('mimeEncrypted')
    const signed = body({ text: 'hi', attachments: [part('application/pgp-signature')] })
    expect(pgpKind(signed)).toBe('mimeSigned')
  })

  it('finds inline armor in a plain-text body only', () => {
    expect(pgpKind(body({ text: 'x\n-----BEGIN PGP MESSAGE-----\n...' }))).toBe('inlineEncrypted')
    expect(pgpKind(body({ text: '-----BEGIN PGP SIGNED MESSAGE-----\n...' }))).toBe('inlineSigned')
    expect(pgpKind(body({ html: '<p>x</p>', text: '-----BEGIN PGP MESSAGE-----\n...' }))).toBeNull()
    expect(pgpKind(body({ text: 'just mail' }))).toBeNull()
  })

  it('ignores parameters and case in a part type', () => {
    const b = body({ attachments: [part('Application/PGP-Signature; name=x.asc')] })
    expect(pgpKind(b)).toBe('mimeSigned')
  })
})

describe('encryptedPart and pgpMachinery', () => {
  it('picks the ciphertext, not the version part', () => {
    const version = part('application/pgp-encrypted')
    const cipher = part('application/octet-stream', { name: 'encrypted.asc' })
    const b = body({ attachments: [version, cipher] })
    expect(encryptedPart(b)).toBe(cipher)
    expect(pgpMachinery(b, 'mimeEncrypted')).toEqual(new Set([version, cipher]))
  })

  it('hides only the signature of a signed message', () => {
    const sig = part('application/pgp-signature')
    const doc = part('application/pdf')
    const b = body({ attachments: [doc, sig] })
    expect(pgpMachinery(b, 'mimeSigned')).toEqual(new Set([sig]))
    expect(pgpMachinery(b, 'inlineSigned').size).toBe(0)
  })
})

describe('canonicalLines', () => {
  it('turns bare LF into CRLF and leaves CRLF alone', () => {
    expect(text(canonicalLines(bytes('a\nb\r\nc\n')))).toBe('a\r\nb\r\nc\r\n')
  })
})

describe('splitSigned', () => {
  const signedPart = 'Content-Type: text/plain; charset=utf-8\r\n\r\nSigned hello.\r\n'
  const message = (headers: string, nl = '\r\n') =>
    [
      'From: bob@localhost',
      headers,
      '',
      'preamble',
      '--B1',
      signedPart.replace(/\r\n$/, ''),
      '',
      '--B1',
      'Content-Type: application/pgp-signature; name="signature.asc"',
      '',
      SIG,
      '--B1--',
      '',
    ].join(nl)

  it('returns the first part byte for byte, headers included, and the signature', () => {
    const raw = bytes(
      message(
        'Content-Type: multipart/signed; micalg=pgp-sha512;\r\n protocol="application/pgp-signature"; boundary="B1"',
      ),
    )
    const out = splitSigned(raw)!
    expect(text(out.signed)).toBe(signedPart)
    expect(out.signature).toBe(SIG)
  })

  it('canonicalises a message that arrived with bare LF', () => {
    const raw = bytes(
      message(
        'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary=B1',
        '\n',
      ),
    )
    expect(text(splitSigned(raw)!.signed)).toBe(signedPart)
  })

  it('does not mistake a boundary-like string inside the content for a delimiter', () => {
    const raw = bytes(
      [
        'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="B1"',
        '',
        '--B1',
        'Content-Type: text/plain',
        '',
        'text mentioning --B1 in the middle',
        '--B1',
        '',
        SIG,
        '--B1--',
      ].join('\r\n'),
    )
    expect(text(splitSigned(raw)!.signed)).toBe(
      'Content-Type: text/plain\r\n\r\ntext mentioning --B1 in the middle',
    )
  })

  it('refuses anything that is not a top-level PGP multipart/signed', () => {
    expect(splitSigned(bytes('Content-Type: text/plain\r\n\r\nhi'))).toBeNull()
    expect(
      splitSigned(
        bytes(
          message(
            'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=B1',
          ),
        ),
      ),
    ).toBeNull()
    expect(
      splitSigned(
        bytes(message('Content-Type: multipart/signed; protocol="application/pgp-signature"')),
      ),
    ).toBeNull()
    // No closing delimiter after the signature.
    expect(
      splitSigned(
        bytes(
          'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary=B1\r\n\r\n--B1\r\nx\r\n--B1\r\n' +
            SIG,
        ),
      ),
    ).toBeNull()
    // A signature part without armor.
    expect(
      splitSigned(
        bytes(
          'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary=B1\r\n\r\n--B1\r\nx\r\n--B1\r\n\r\nnothing\r\n--B1--',
        ),
      ),
    ).toBeNull()
  })
})

describe('isSignedEntity', () => {
  it('reads the entity’s own Content-Type', () => {
    expect(isSignedEntity(bytes('Content-Type: multipart/signed; boundary=x\r\n\r\n'))).toBe(true)
    expect(isSignedEntity(bytes('Content-Type: text/plain\r\n\r\n'))).toBe(false)
  })
})

describe('inlineBlock', () => {
  it('splits the armor from the text around it', () => {
    const t = 'Hi,\n-----BEGIN PGP MESSAGE-----\nxyz\n-----END PGP MESSAGE-----\nbye'
    expect(inlineBlock(t, 'inlineEncrypted')).toEqual({
      before: 'Hi,\n',
      armor: '-----BEGIN PGP MESSAGE-----\nxyz\n-----END PGP MESSAGE-----',
      after: '\nbye',
    })
  })

  it('takes a clearsigned block up to the end of its signature', () => {
    const t = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhello\n' + SIG
    expect(inlineBlock(t, 'inlineSigned')?.armor).toBe(t)
  })

  it('answers null for an unterminated block', () => {
    expect(inlineBlock('-----BEGIN PGP MESSAGE-----\nxyz', 'inlineEncrypted')).toBeNull()
    expect(inlineBlock('nothing here', 'inlineSigned')).toBeNull()
  })
})

describe('formatFingerprint', () => {
  it('groups by four, upper case', () => {
    expect(formatFingerprint('abcdef0123456789')).toBe('ABCD EF01 2345 6789')
  })
})
