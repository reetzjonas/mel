// @vitest-environment node
// OpenPGP.js checks `instanceof Uint8Array`; see pgp.test.ts.
import * as openpgp from 'openpgp'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { emptyContact, storedContact, type Contact } from '../domain/contact'
import { keyFromText, keyText } from '../domain/contactKey'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { autocryptOffer, ownAutocryptKeydata, saveAutocryptKey } from './autocrypt'
import { importOwnKey } from './pgpKeys'

const ACC = 'acc-autocrypt'
const PASS = 'correct horse'

let alice: openpgp.PrivateKey // the user, with two addresses and a signing subkey
let bob: openpgp.PrivateKey
let bobNew: openpgp.PrivateKey

beforeAll(async () => {
  const gen = async (userIDs: { name?: string; email: string }[], extra: object = {}) =>
    (await openpgp.generateKey({ userIDs, format: 'object', ...extra })).privateKey
  ;[alice, bob, bobNew] = await Promise.all([
    gen([{ name: 'Alice', email: 'alice@example.com' }, { email: 'alice@work.example' }], {
      subkeys: [{ sign: true }, {}],
    }),
    gen([{ name: 'Bob', email: 'bob@example.com' }]),
    gen([{ name: 'Bob', email: 'bob@example.com' }]),
  ])
})

const keydataOf = (key: openpgp.Key) => btoa(String.fromCharCode(...key.toPublic().write()))
const header = (addr: string, key: openpgp.Key) => [`addr=${addr}; keydata=${keydataOf(key)}`]

function card(id: string, email: string, keys: openpgp.Key[] = []) {
  const c: Contact = {
    ...emptyContact('ab1'),
    id,
    fullName: 'Bob',
    emails: [{ label: null, value: email }],
    cryptoKeys: keys.map((k) => keyFromText(k.toPublic().armor())!),
  }
  return {
    accountId: ACC,
    id,
    addressBookIds: ['ab1'],
    sortKey: 'bob',
    payload: sealPlain(c) as never,
  }
}

async function contacts(): Promise<Contact[]> {
  const rows = await db.contacts.where('accountId').equals(ACC).toArray()
  return rows.map((r) => storedContact(openEnvelope(r.payload)))
}

beforeEach(async () => {
  await db.pgpKeys.clear()
  await db.contacts.clear()
  await db.addressBooks.clear()
  await db.outbox.clear()
})

describe('ownAutocryptKeydata', () => {
  it('is nothing without a key', async () => {
    expect(await ownAutocryptKeydata(ACC, 'alice@example.com')).toBeNull()
  })

  it('sends the smallest key that still works: one user id, the encryption subkey', async () => {
    const sealed = await openpgp.encryptKey({ privateKey: alice, passphrase: PASS })
    await importOwnKey(ACC, sealed.armor(), PASS)
    const keydata = await ownAutocryptKeydata(ACC, 'Alice@Work.example')
    const key = await openpgp.readKey({
      binaryKey: Uint8Array.from(atob(keydata!), (c) => c.charCodeAt(0)),
    })

    expect(key.isPrivate()).toBe(false)
    expect(key.getFingerprint()).toBe(alice.getFingerprint())
    expect(key.getUserIDs()).toEqual(['<alice@work.example>'])
    expect(key.subkeys).toHaveLength(1)
    const encryption = await alice.getEncryptionKey()
    expect(key.subkeys[0]!.getKeyID().equals(encryption.getKeyID())).toBe(true)

    // Still a key someone can write to.
    const message = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'hi' }),
      encryptionKeys: key,
    })
    const { data } = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: message }),
      decryptionKeys: alice,
    })
    expect(data).toBe('hi')
  })

  it('offers nothing for an address the key does not name', async () => {
    await importOwnKey(ACC, alice.armor(), PASS)
    expect(await ownAutocryptKeydata(ACC, 'someone@else.example')).toBeNull()
  })
})

describe('autocryptOffer', () => {
  const sender = { name: 'Bob', email: 'Bob@Example.com' }

  it('offers a new contact when nobody has the address', async () => {
    const offer = await autocryptOffer(ACC, header('bob@example.com', bob), sender)
    expect(offer).toMatchObject({
      kind: 'add',
      contactId: null,
      sender: { name: 'Bob', email: 'bob@example.com' },
      info: { fingerprint: bob.getFingerprint() },
    })
  })

  it('offers the existing card when it has no key yet', async () => {
    await db.contacts.put(card('c1', 'bob@example.com'))
    expect(await autocryptOffer(ACC, header('bob@example.com', bob), sender)).toMatchObject({
      kind: 'add',
      contactId: 'c1',
    })
  })

  it('stays quiet when the card already has that key', async () => {
    await db.contacts.put(card('c1', 'bob@example.com', [bob]))
    expect(await autocryptOffer(ACC, header('bob@example.com', bob), sender)).toBeNull()
  })

  it('warns when the card has a different key, and changes nothing', async () => {
    await db.contacts.put(card('c1', 'bob@example.com', [bob]))
    expect(await autocryptOffer(ACC, header('bob@example.com', bobNew), sender)).toMatchObject({
      kind: 'differs',
      info: { fingerprint: bobNew.getFingerprint() },
    })
  })

  it('ignores a header for someone else, and one that holds no key', async () => {
    expect(await autocryptOffer(ACC, header('mallory@example.com', bob), sender)).toBeNull()
    expect(await autocryptOffer(ACC, ['addr=bob@example.com; keydata=AAAA'], sender)).toBeNull()
  })
})

describe('saveAutocryptKey', () => {
  const sender = { name: 'Bob', email: 'bob@example.com' }

  it('adds the key to the card beside what it had', async () => {
    await db.contacts.put(card('c1', 'bob@example.com'))
    const offer = await autocryptOffer(ACC, header('bob@example.com', bob), sender)
    if (offer?.kind !== 'add') throw new Error('expected an offer')
    await saveAutocryptKey(ACC, offer)

    const [saved] = await contacts()
    expect(saved!.cryptoKeys).toHaveLength(1)
    const key = await openpgp.readKey({ armoredKey: keyText(saved!.cryptoKeys[0]!)! })
    expect(key.getFingerprint()).toBe(bob.getFingerprint())
    expect(await db.outbox.count()).toBe(1)
    // The next message from Bob has nothing more to offer.
    expect(await autocryptOffer(ACC, header('bob@example.com', bob), sender)).toBeNull()
  })

  it('makes a contact for a sender who had none, in the default address book', async () => {
    await db.addressBooks.bulkPut([
      { accountId: ACC, id: 'ab1', payload: sealPlain({ id: 'ab1', name: 'A', isDefault: false }) },
      { accountId: ACC, id: 'ab2', payload: sealPlain({ id: 'ab2', name: 'B', isDefault: true }) },
    ] as never)
    const offer = await autocryptOffer(ACC, header('bob@example.com', bob), sender)
    if (offer?.kind !== 'add') throw new Error('expected an offer')
    await saveAutocryptKey(ACC, offer)

    const [made] = await contacts()
    expect(made).toMatchObject({
      fullName: 'Bob',
      emails: [{ value: 'bob@example.com', label: null }],
      addressBookIds: { ab2: true },
    })
    expect(made!.cryptoKeys).toHaveLength(1)
  })
})
