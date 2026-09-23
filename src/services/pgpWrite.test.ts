// @vitest-environment node
// OpenPGP.js and postal-mime check `instanceof Uint8Array`; see pgp.test.ts.
import * as openpgp from 'openpgp'
import PostalMime from 'postal-mime'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Contact } from '../domain/contact'
import type { OutgoingEmail } from '../domain/identity'
import { splitSigned } from '../domain/pgp'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { importOwnKey, lockOwnKeys } from './pgpKeys'
import { buildSecureMessage, recipientsWithoutKey, SecureSendError } from './pgpWrite'

const ACC = 'acc-pgp-write'
const PASS = 'correct horse'

let alice: openpgp.PrivateKey // the user
let bob: openpgp.PrivateKey // a contact with a key
let expired: openpgp.PrivateKey // a contact whose key has run out

beforeAll(async () => {
  const gen = async (email: string, extra: object = {}) =>
    (await openpgp.generateKey({ userIDs: [{ email }], format: 'object', ...extra })).privateKey
  ;[alice, bob, expired] = await Promise.all([
    gen('alice@example.com'),
    gen('bob@example.com'),
    gen('old@example.com', { date: new Date(Date.now() - 86_400_000), keyExpirationTime: 60 }),
  ])
})

function card(email: string, key: openpgp.PrivateKey) {
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
        uri: `data:application/pgp-keys;base64,${btoa(key.toPublic().armor())}`,
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

const mail = (extra: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  identityId: 'i1',
  from: { name: 'Alice', email: 'alice@example.com' },
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Geheim',
  text: 'Der Kuchen ist im Schrank.',
  html: '<p>Der Kuchen ist im <b>Schrank</b>.</p>',
  attachments: [],
  inReplyTo: ['parent@example.com'],
  references: ['parent@example.com'],
  ...extra,
})

beforeEach(async () => {
  await db.pgpKeys.clear()
  await db.contacts.clear()
  lockOwnKeys()
  await db.contacts.bulkPut([card('bob@example.com', bob), card('old@example.com', expired)])
  await importOwnKey(
    ACC,
    (await openpgp.encryptKey({ privateKey: alice, passphrase: PASS })).armor(),
    PASS,
  )
})

async function decryptFor(raw: string, key: openpgp.PrivateKey) {
  const parsed = await PostalMime.parse(raw)
  expect(parsed.attachments.map((a) => a.mimeType)).toEqual([
    'application/pgp-encrypted',
    'application/octet-stream',
  ])
  const armored = new TextDecoder().decode(parsed.attachments[1]!.content as ArrayBuffer)
  const result = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: armored }),
    decryptionKeys: key,
    verificationKeys: alice.toPublic(),
    format: 'binary',
  })
  return { parsed, result, inner: await PostalMime.parse(result.data) }
}

describe('buildSecureMessage', () => {
  it('encrypts to the recipient and to the user, signed, with the headers outside', async () => {
    const file = { name: 'plan.txt', type: 'text/plain', data: new TextEncoder().encode('step 1') }
    const raw = await buildSecureMessage(ACC, mail(), [file], { encrypt: true, sign: true })

    const forBob = await decryptFor(raw, bob)
    expect(forBob.parsed.subject).toBe('Geheim')
    expect(forBob.parsed.inReplyTo).toBe('<parent@example.com>')
    expect(forBob.parsed.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)
    expect(forBob.inner.text?.trim()).toBe('Der Kuchen ist im Schrank.')
    expect(forBob.inner.html).toContain('<b>Schrank</b>')
    expect(forBob.inner.attachments[0]).toMatchObject({ filename: 'plan.txt' })
    await expect(forBob.result.signatures[0]!.verified).resolves.toBe(true)
    // Nothing of the body is readable outside the ciphertext.
    expect(raw).not.toContain('Kuchen')
    expect(raw).not.toContain(btoa('Der Kuchen'))

    // The copy in Sent stays readable to the user.
    const forAlice = await decryptFor(raw, alice)
    expect(forAlice.inner.text?.trim()).toBe('Der Kuchen ist im Schrank.')
  })

  it('encrypts without signing when asked, and needs no unlocked key for it', async () => {
    lockOwnKeys(ACC)
    const raw = await buildSecureMessage(ACC, mail(), [], { encrypt: true, sign: false })
    const { result } = await decryptFor(raw, bob)
    expect(result.signatures).toEqual([])
  })

  it('signs a message as multipart/signed that its own reader verifies', async () => {
    const raw = await buildSecureMessage(ACC, mail(), [], { encrypt: false, sign: true })
    expect(raw).toMatch(/Content-Type: multipart\/signed; boundary="[^"]+"; micalg=pgp-sha\d+;/)
    const split = splitSigned(new TextEncoder().encode(raw))!
    const verified = await openpgp.verify({
      message: await openpgp.createMessage({ binary: split.signed }),
      signature: await openpgp.readSignature({ armoredSignature: split.signature }),
      verificationKeys: alice.toPublic(),
      format: 'binary',
    })
    await expect(verified.signatures[0]!.verified).resolves.toBe(true)
    const parsed = await PostalMime.parse(raw)
    expect(parsed.text?.trim()).toBe('Der Kuchen ist im Schrank.')
  })

  it('refuses before encrypting to anyone when a recipient — Bcc too — has no usable key', async () => {
    const attempt = buildSecureMessage(
      ACC,
      mail({
        cc: [{ name: null, email: 'old@example.com' }],
        bcc: [{ name: null, email: 'carol@example.com' }],
      }),
      [],
      { encrypt: true, sign: true },
    )
    await expect(attempt).rejects.toBeInstanceOf(SecureSendError)
    await expect(attempt).rejects.toMatchObject({
      problem: { kind: 'missingKeys', addresses: ['old@example.com', 'carol@example.com'] },
    })
  })

  it('says when the key is locked, when there is none, and when nothing was asked', async () => {
    lockOwnKeys(ACC)
    await expect(
      buildSecureMessage(ACC, mail(), [], { encrypt: false, sign: true }),
    ).rejects.toMatchObject({ problem: { kind: 'locked' } })
    await db.pgpKeys.clear()
    await expect(
      buildSecureMessage(ACC, mail(), [], { encrypt: true, sign: false }),
    ).rejects.toMatchObject({ problem: { kind: 'noOwnKey' } })
    await expect(
      buildSecureMessage(ACC, mail(), [], { encrypt: false, sign: false }),
    ).rejects.toThrow()
  })
})

describe('recipientsWithoutKey', () => {
  it('names each address once that has no key, or only an expired one', async () => {
    expect(
      await recipientsWithoutKey(ACC, ['Bob@Example.com', 'old@example.com', 'x@y.z', 'x@y.z', '']),
    ).toEqual(['old@example.com', 'x@y.z'])
  })
})
