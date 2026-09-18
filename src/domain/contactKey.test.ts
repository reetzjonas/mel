import { describe, expect, it } from 'vitest'
import {
  keyBytes,
  keyFileName,
  keyFromText,
  keyKind,
  keySize,
  keyText,
  PGP_MEDIA_TYPE,
  SMIME_MEDIA_TYPE,
  type ContactKey,
} from './contactKey'

const PGP = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEZfakeBYJKwYBBAHaRw8BAQdAfakefakefakefakefakefakefakefakefake=
=abcd
-----END PGP PUBLIC KEY BLOCK-----
`
const CERT = `-----BEGIN CERTIFICATE-----
MIIBfakefakefakefakefakefakefakefakefakefakefakefakefakefakefake
-----END CERTIFICATE-----
`

describe('reading a key off a card', () => {
  it('names the kind from the key itself, not from what the card claims', () => {
    // A card that says nothing, and one that says the wrong thing: the bytes
    // decide, because mediaType is optional and often somebody else's guess.
    const key = keyFromText(PGP)!
    expect(keyKind(key)).toBe('pgp')
    expect(keyKind({ ...key, mediaType: '' })).toBe('pgp')
    expect(keyKind({ ...key, mediaType: 'application/pkix-cert' })).toBe('pgp')
    expect(keyKind(keyFromText(CERT)!)).toBe('smime')
  })

  it('falls back to the media type for a key it cannot read', () => {
    const der: ContactKey = {
      uri: 'https://example.com/erika.crt',
      mediaType: 'application/pkix-cert',
    }
    expect(keyKind(der)).toBe('smime')
    expect(keyKind({ uri: 'https://example.com/k.asc', mediaType: 'application/pgp-keys' })).toBe(
      'pgp',
    )
    expect(keyKind({ uri: 'https://example.com/k', mediaType: '' })).toBe('unknown')
  })

  it('leaves a key it cannot decode on the card rather than throwing', () => {
    // Everything here runs while a contact renders. A card written by another
    // client is not a reason for the screen to go.
    for (const uri of ['data:application/pgp-keys;base64,not base64!!', 'data:', 'nonsense']) {
      expect(keyBytes(uri)).toBeNull()
      expect(keySize({ uri, mediaType: '' })).toBe(0)
      expect(keyText({ uri, mediaType: '' })).toBeNull()
      expect(keyKind({ uri, mediaType: '' })).toBe('unknown')
    }
  })

  it('reads a plain, un-base64d data: URI too', () => {
    const uri = `data:application/pgp-keys,${encodeURIComponent(PGP)}`
    expect(keyText({ uri, mediaType: PGP_MEDIA_TYPE })).toContain('BEGIN PGP PUBLIC KEY BLOCK')
    expect(keyKind({ uri, mediaType: '' })).toBe('pgp')
  })

  it('does not mistake a DER certificate for text', () => {
    // Bytes that decode to something, just not to armor.
    const uri = `data:application/pkix-cert;base64,${btoa('\x30\x82\x01\x0a\xff\xfe')}`
    expect(keyText({ uri, mediaType: '' })).toBeNull()
    expect(keySize({ uri, mediaType: '' })).toBe(6)
    expect(keyKind({ uri, mediaType: 'application/pkix-cert' })).toBe('smime')
  })
})

describe('taking a key in', () => {
  it('keeps the armor and drops what was pasted around it', () => {
    const key = keyFromText(`Here is my key, hope it helps!\n\n${PGP}\n-- \nErika`)
    expect(key!.mediaType).toBe(PGP_MEDIA_TYPE)
    expect(keyText(key!)).toBe(PGP.trimEnd() + '\n')
  })

  it('takes a PEM certificate as S/MIME', () => {
    const key = keyFromText(CERT)!
    expect(key.mediaType).toBe(SMIME_MEDIA_TYPE)
    expect(keyText(key)).toContain('BEGIN CERTIFICATE')
  })

  it('refuses anything that is not a key', () => {
    // Storing "whatever you gave us" under a heading that says "public key" is
    // worse than storing nothing: the point of the field is that it is right.
    expect(keyFromText('')).toBeNull()
    expect(keyFromText('-----BEGIN PGP PUBLIC KEY BLOCK-----\nno end in sight')).toBeNull()
    expect(
      keyFromText('-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----'),
    ).toBeNull()
    expect(keyFromText('-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----')).toBeNull()
  })

  it('names the download after the contact and the kind', () => {
    expect(keyFileName(keyFromText(PGP)!, 'Erika Mustermann')).toBe('Erika-Mustermann.asc')
    expect(keyFileName(keyFromText(CERT)!, 'Erika Mustermann')).toBe('Erika-Mustermann.pem')
    expect(keyFileName({ uri: 'https://x/k', mediaType: '' }, '  ')).toBe('contact.key')
    expect(keyFileName(keyFromText(PGP)!, '大和 太郎')).toBe('大和-太郎.asc')
  })
})
