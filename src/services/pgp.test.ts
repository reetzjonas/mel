// @vitest-environment node
// OpenPGP.js checks `instanceof Uint8Array`, and under jsdom TextEncoder hands
// out arrays from another realm. The browser has one realm, so node is closer.
import * as openpgp from 'openpgp'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '../domain/contact'
import type { EmailBody, EmailBodyPart } from '../domain/email'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import {
  contactKeysFor,
  describeKey,
  importOwnKey,
  inspectSecretKey,
  isUnlocked,
  keysVersion,
  lockOwnKeys,
  onKeysChanged,
  ownKeys,
  removeOwnKey,
  unlockedKeys,
  unlockOwnKeys,
} from './pgpKeys'
import { openSecure, type SecureInput } from './pgpRead'

const blobs = new Map<string, Uint8Array>()
const conn = {
  mail: {
    getEmailMetadata: vi.fn(async (id: string) => ({ headers: [], blobId: `raw-${id}` })),
    downloadBlob: vi.fn(async (blobId: string) => {
      const data = blobs.get(blobId)
      if (!data) throw new Error('offline')
      return new Blob([data as BlobPart])
    }),
  },
}
vi.mock('../sync/connections', () => ({ connectionFor: async () => conn }))

const ACC = 'acc-pgp'
const PASS = 'correct horse'
const enc = (s: string) => new TextEncoder().encode(s)

let alice: openpgp.PrivateKey // the user
let bob: openpgp.PrivateKey // a contact
let mallory: openpgp.PrivateKey // nobody mel knows
let aliceProtected: string

beforeAll(async () => {
  const gen = async (email: string) =>
    (await openpgp.generateKey({ userIDs: [{ email }], format: 'object' })).privateKey
  ;[alice, bob, mallory] = await Promise.all([
    gen('alice@example.com'),
    gen('bob@example.com'),
    gen('mallory@example.com'),
  ])
  aliceProtected = (await openpgp.encryptKey({ privateKey: alice, passphrase: PASS })).armor()
})

function contactRow(email: string, publicKey: string) {
  const c: Contact = {
    id: `c-${email}`,
    addressBookIds: { ab1: true },
    kind: 'individual',
    fullName: email,
    given: '',
    surname: '',
    nickname: '',
    organization: '',
    jobTitle: '',
    emails: [{ label: null, value: email }],
    phones: [],
    addresses: [],
    urls: [],
    onlineServices: [],
    keywords: [],
    cryptoKeys: [
      {
        uri: `data:application/pgp-keys;base64,${btoa(publicKey)}`,
        mediaType: 'application/pgp-keys',
      },
    ],
    photo: '',
    birthday: '',
    note: '',
    memberUids: [],
  }
  return {
    accountId: ACC,
    id: c.id,
    addressBookIds: ['ab1'],
    sortKey: email,
    payload: sealPlain(c) as never,
  }
}

const part = (type: string, blobId: string): EmailBodyPart => ({
  partId: blobId,
  blobId,
  type,
  name: null,
  disposition: null,
  cid: null,
  size: 1,
})

const body = (extra: Partial<EmailBody>): EmailBody => ({
  emailId: 'e1',
  html: null,
  text: null,
  attachments: [],
  messageId: null,
  references: null,
  ...extra,
})

const input = (
  b: EmailBody,
  kind: SecureInput['kind'],
  sender = 'bob@example.com',
): SecureInput => ({
  emailId: 'e1',
  body: b,
  kind,
  sender,
  fromSelf: false,
})

beforeEach(async () => {
  await db.pgpKeys.clear()
  await db.contacts.clear()
  blobs.clear()
  lockOwnKeys()
  await db.contacts.put(contactRow('bob@example.com', bob.toPublic().armor()))
})

describe('own key import', () => {
  it('says what it was handed before asking for anything', async () => {
    expect(await inspectSecretKey('not a key')).toEqual({ kind: 'invalid' })
    expect(await inspectSecretKey(bob.toPublic().armor())).toEqual({ kind: 'public' })
    const p = await inspectSecretKey(aliceProtected)
    expect(p.kind).toBe('protected')
    expect(p.kind === 'protected' && p.info.userIds).toEqual(['<alice@example.com>'])
    expect((await inspectSecretKey(alice.armor())).kind).toBe('unprotected')
    expect((await inspectSecretKey(alice.write())).kind).toBe('unprotected')
  })

  it('keeps a protected key as it came, after checking the passphrase opens it', async () => {
    expect(await importOwnKey(ACC, aliceProtected, 'wrong')).toBe('wrongPassphrase')
    expect(await ownKeys(ACC)).toEqual([])
    expect(await importOwnKey(ACC, aliceProtected, PASS)).toBe('ok')
    const [stored] = await ownKeys(ACC)
    expect(stored!.fingerprint).toBe(alice.getFingerprint())
    expect(stored!.armored).toBe(aliceProtected)
    expect(stored!.expires).toBeNull()
    // Unlocked right away: the passphrase was just typed.
    expect(isUnlocked(ACC, alice.getFingerprint())).toBe(true)
  })

  it('never stores an unprotected key as it came', async () => {
    expect(await importOwnKey(ACC, alice.armor(), '')).toBe('invalid')
    expect(await importOwnKey(ACC, alice.armor(), PASS)).toBe('ok')
    const [stored] = await ownKeys(ACC)
    const read = await openpgp.readPrivateKey({ armoredKey: stored!.armored })
    expect(read.isDecrypted()).toBe(false)
    await expect(openpgp.decryptKey({ privateKey: read, passphrase: PASS })).resolves.toBeTruthy()
  })

  it('refuses what is not a secret key', async () => {
    expect(await importOwnKey(ACC, bob.toPublic().armor(), PASS)).toBe('invalid')
  })

  it('locks, unlocks with the right passphrase only, and removes', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    const seen = vi.fn()
    const off = onKeysChanged(seen)
    const before = keysVersion()
    lockOwnKeys(ACC)
    expect(unlockedKeys(ACC)).toEqual([])
    expect(await unlockOwnKeys(ACC, 'wrong')).toBe(0)
    expect(await unlockOwnKeys(ACC, PASS)).toBe(1)
    expect(unlockedKeys(ACC)).toHaveLength(1)
    await removeOwnKey(ACC, alice.getFingerprint())
    expect(await ownKeys(ACC)).toEqual([])
    expect(unlockedKeys(ACC)).toEqual([])
    expect(seen).toHaveBeenCalledTimes(3)
    expect(keysVersion()).toBe(before + 3)
    off()
  })
})

describe('contact keys and describing a key', () => {
  it('finds keys by exact address, any case, over every card', async () => {
    await db.contacts.put({
      ...contactRow('Bob@Example.com', mallory.toPublic().armor()),
      id: 'second-card',
    })
    const keys = await contactKeysFor(ACC, ' BOB@example.com ')
    expect(keys.map((k) => k.getFingerprint()).sort()).toEqual(
      [bob.getFingerprint(), mallory.getFingerprint()].sort(),
    )
    expect(await contactKeysFor(ACC, 'bob@example.co')).toEqual([])
    expect(await contactKeysFor(ACC, '')).toEqual([])
  })

  it('skips a damaged key on a card', async () => {
    await db.contacts.put(
      contactRow(
        'eve@example.com',
        '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\ngarbage\n-----END PGP PUBLIC KEY BLOCK-----',
      ),
    )
    expect(await contactKeysFor(ACC, 'eve@example.com')).toEqual([])
  })

  it('describes a public key, or answers null', async () => {
    const info = await describeKey(bob.toPublic().armor())
    expect(info).toMatchObject({
      fingerprint: bob.getFingerprint(),
      userIds: ['<bob@example.com>'],
      revoked: false,
      algorithm: expect.stringMatching(/25519/),
    })
    expect(await describeKey('nope')).toBeNull()
  })
})

async function encryptTo(text: string, signingKeys?: openpgp.PrivateKey) {
  return openpgp.encrypt({
    message: await openpgp.createMessage({ text }),
    encryptionKeys: alice.toPublic(),
    ...(signingKeys ? { signingKeys } : {}),
  })
}

function signedMessage(content: string, signature: string) {
  return enc(
    [
      'From: bob@example.com',
      'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="S"',
      '',
      '--S',
      // The content ends in its own CRLF; the one before the delimiter
      // belongs to the delimiter.
      content,
      '--S',
      'Content-Type: application/pgp-signature',
      '',
      signature,
      '--S--',
      '',
    ].join('\r\n'),
  )
}

async function detached(content: string, key: openpgp.PrivateKey) {
  return openpgp.sign({
    message: await openpgp.createMessage({ binary: enc(content) }),
    signingKeys: key,
    detached: true,
  })
}

const SIGNED_PART = 'Content-Type: text/plain; charset=utf-8\r\n\r\nSigned hello.\r\n'
const signedBody = body({
  text: 'Signed hello.',
  attachments: [part('application/pgp-signature', 'sig')],
})

describe('openSecure: signed PGP/MIME', () => {
  it('verifies against the key on the sender’s card', async () => {
    blobs.set('raw-e1', signedMessage(SIGNED_PART, await detached(SIGNED_PART, bob)))
    expect(await openSecure(ACC, input(signedBody, 'mimeSigned'))).toEqual({
      state: 'open',
      encrypted: false,
      signature: {
        state: 'valid',
        signer: '<bob@example.com>',
        fingerprint: bob.getFingerprint(),
        own: false,
      },
      partial: false,
      content: null,
    })
  })

  it('accepts a text-mode signature too', async () => {
    const sig = await openpgp.sign({
      message: await openpgp.createMessage({ text: SIGNED_PART }),
      signingKeys: bob,
      detached: true,
    })
    blobs.set('raw-e1', signedMessage(SIGNED_PART, sig))
    const view = await openSecure(ACC, input(signedBody, 'mimeSigned'))
    expect(view?.state === 'open' && view.signature?.state).toBe('valid')
  })

  it('calls altered content invalid', async () => {
    const sig = await detached(SIGNED_PART, bob)
    blobs.set('raw-e1', signedMessage(SIGNED_PART.replace('hello', 'HELLO'), sig))
    const view = await openSecure(ACC, input(signedBody, 'mimeSigned'))
    expect(view?.state === 'open' && view.signature).toEqual({ state: 'invalid' })
  })

  it('does not trust a key from another card, or no card', async () => {
    blobs.set('raw-e1', signedMessage(SIGNED_PART, await detached(SIGNED_PART, mallory)))
    const view = await openSecure(ACC, input(signedBody, 'mimeSigned'))
    expect(view?.state === 'open' && view.signature).toEqual({
      state: 'unknownKey',
      keyId: mallory.getKeyID().toHex(),
    })
    // Bob's signature, but the From says someone else: Bob's card does not count.
    blobs.set('raw-e1', signedMessage(SIGNED_PART, await detached(SIGNED_PART, bob)))
    const spoofed = await openSecure(ACC, input(signedBody, 'mimeSigned', 'carol@example.com'))
    expect(spoofed?.state === 'open' && spoofed.signature?.state).toBe('unknownKey')
  })

  it('recognises the user’s own signature on their own mail', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    blobs.set('raw-e1', signedMessage(SIGNED_PART, await detached(SIGNED_PART, alice)))
    const view = await openSecure(ACC, {
      ...input(signedBody, 'mimeSigned', 'alice@example.com'),
      fromSelf: true,
    })
    expect(view?.state === 'open' && view.signature).toMatchObject({ state: 'valid', own: true })
  })

  it('says unavailable when the raw message cannot be fetched, and nothing when it is not top-level signed', async () => {
    expect(await openSecure(ACC, input(signedBody, 'mimeSigned'))).toEqual({ state: 'unavailable' })
    blobs.set('raw-e1', enc('Content-Type: multipart/mixed; boundary=x\r\n\r\n--x--'))
    expect(await openSecure(ACC, input(signedBody, 'mimeSigned'))).toBeNull()
    conn.mail.getEmailMetadata.mockResolvedValueOnce(null as never)
    expect(await openSecure(ACC, input(signedBody, 'mimeSigned'))).toEqual({ state: 'unavailable' })
  })
})

const encryptedBody = body({
  attachments: [
    part('application/pgp-encrypted', 'ver'),
    part('application/octet-stream', 'cipher'),
  ],
})

describe('openSecure: encrypted PGP/MIME', () => {
  it('asks for a key that is not there, and for a passphrase when locked', async () => {
    expect(await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))).toEqual({ state: 'noKey' })
    await importOwnKey(ACC, aliceProtected, PASS)
    lockOwnKeys(ACC)
    expect(await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))).toEqual({
      state: 'locked',
    })
  })

  it('decrypts, parses the MIME inside and checks the signature that came with it', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    const entity = [
      'Content-Type: multipart/mixed; boundary="M"',
      '',
      '--M',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Geheim</p>',
      '--M',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'attached',
      '--M--',
      '',
    ].join('\r\n')
    blobs.set('cipher', enc(await encryptTo(entity, bob)))
    const view = await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))
    expect(view).toMatchObject({
      state: 'open',
      encrypted: true,
      signature: { state: 'valid', signer: '<bob@example.com>' },
      content: { html: expect.stringContaining('<p>Geheim</p>') },
    })
    const content = view?.state === 'open' ? view.content : null
    expect(content?.attachments).toHaveLength(1)
    expect(content?.attachments[0]).toMatchObject({ name: 'notes.txt', type: 'text/plain' })
    expect(new TextDecoder().decode(content!.attachments[0]!.data)).toMatch(/^attached\r?\n?$/)
  })

  it('checks a multipart/signed entity inside the encryption', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    const inner = signedMessage(SIGNED_PART, await detached(SIGNED_PART, bob))
    blobs.set('cipher', enc(await encryptTo(new TextDecoder().decode(inner))))
    const view = await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))
    expect(view).toMatchObject({ state: 'open', signature: { state: 'valid' } })
    // The signature is not offered as an attachment.
    expect(view?.state === 'open' && view.content?.attachments).toEqual([])
    expect(view?.state === 'open' && view.content?.text).toContain('Signed hello.')
  })

  it('reads binary ciphertext, and leaves an unsigned message unsigned', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    const binary = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'Content-Type: text/plain\r\n\r\nplain' }),
      encryptionKeys: alice.toPublic(),
      format: 'binary',
    })
    blobs.set('cipher', binary)
    const view = await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))
    expect(view).toMatchObject({
      state: 'open',
      signature: null,
      content: { text: expect.stringMatching(/^plain\n?$/) },
    })
  })

  it('tells someone else’s message from a locked key', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    const forMallory = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'x' }),
      encryptionKeys: mallory.toPublic(),
    })
    blobs.set('cipher', enc(forMallory))
    expect(await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))).toEqual({
      state: 'undecryptable',
    })
    // With a second stored key still locked, it might be that one's.
    await db.pgpKeys.put({
      accountId: ACC,
      fingerprint: 'other',
      payload: sealPlain({ fingerprint: 'other' }) as never,
    })
    expect(await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))).toEqual({
      state: 'locked',
    })
  })

  it('says unavailable when the ciphertext cannot be fetched', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    expect(await openSecure(ACC, input(encryptedBody, 'mimeEncrypted'))).toEqual({
      state: 'unavailable',
    })
    const noCipher = body({ attachments: [part('application/pgp-encrypted', 'ver')] })
    noCipher.attachments[0]!.blobId = 'ver'
    expect(
      await openSecure(
        ACC,
        input(
          {
            ...noCipher,
            attachments: [{ ...noCipher.attachments[0]!, type: 'application/pgp-encrypted' }],
          },
          'mimeEncrypted',
        ),
      ),
    ).toEqual({ state: 'undecryptable' })
  })
})

describe('openSecure: inline', () => {
  it('decrypts an inline block and marks the text around it as not covered', async () => {
    await importOwnKey(ACC, aliceProtected, PASS)
    const armor = (await encryptTo('the secret', bob)).trimEnd()
    const view = await openSecure(
      ACC,
      input(body({ text: `Hi,\n${armor}\nbye` }), 'inlineEncrypted'),
    )
    expect(view).toMatchObject({
      state: 'open',
      encrypted: true,
      partial: true,
      signature: { state: 'valid' },
      content: { text: 'Hi,\nthe secret\nbye', html: null },
    })
    const alone = await openSecure(ACC, input(body({ text: armor }), 'inlineEncrypted'))
    expect(alone).toMatchObject({ partial: false, content: { text: 'the secret' } })
  })

  it('verifies a clearsigned block and shows the signed words without the armor', async () => {
    const signed = (
      await openpgp.sign({
        message: await openpgp.createCleartextMessage({ text: 'I agree.' }),
        signingKeys: bob,
      })
    ).trimEnd()
    const view = await openSecure(ACC, input(body({ text: signed }), 'inlineSigned'))
    expect(view).toMatchObject({
      state: 'open',
      encrypted: false,
      partial: false,
      signature: { state: 'valid' },
      content: { text: 'I agree.' },
    })
    const tampered = signed.replace('I agree.', 'I disagree.')
    const bad = await openSecure(ACC, input(body({ text: tampered }), 'inlineSigned'))
    expect(bad?.state === 'open' && bad.signature).toEqual({ state: 'invalid' })
  })

  it('answers null for a broken block, and invalid for unreadable armor', async () => {
    expect(
      await openSecure(
        ACC,
        input(body({ text: '-----BEGIN PGP SIGNED MESSAGE-----' }), 'inlineSigned'),
      ),
    ).toBeNull()
    await importOwnKey(ACC, aliceProtected, PASS)
    expect(
      await openSecure(
        ACC,
        input(body({ text: '-----BEGIN PGP MESSAGE-----' }), 'inlineEncrypted'),
      ),
    ).toBeNull()
    const junk =
      '-----BEGIN PGP SIGNED MESSAGE-----\nx\n-----BEGIN PGP SIGNATURE-----\n-----END PGP SIGNATURE-----'
    const view = await openSecure(ACC, input(body({ text: junk }), 'inlineSigned'))
    expect(view?.state === 'open' && view.signature).toEqual({ state: 'invalid' })
    const garbled = '-----BEGIN PGP MESSAGE-----\nxx\n-----END PGP MESSAGE-----'
    expect(await openSecure(ACC, input(body({ text: garbled }), 'inlineEncrypted'))).toEqual({
      state: 'undecryptable',
    })
  })
})
