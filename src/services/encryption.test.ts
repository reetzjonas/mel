import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailHeader } from '../domain/email'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { lock } from '../storage/crypto/keyring'
import { isAccountEncrypted, markAccountEncrypted } from '../storage/crypto/middleware'
import {
  disableEncryption,
  enableEncryption,
  initEncryptionState,
  unlockAccount,
} from './encryption'

const ACC = 'acc-1'
const OTHER = 'acc-2'
const PASS = 'korrekt-pferd-batterie'

const header = (id: string, subject: string): EmailHeader =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [],
    to: [],
    cc: [],
    subject,
    preview: '',
    receivedAt: 0,
    hasAttachment: false,
  }) as unknown as EmailHeader

async function seed(accountId: string, subject = 'Rechnung') {
  await db.accounts.put({
    id: accountId,
    provider: 'jmap',
    encrypted: false,
    payload: sealPlain({ account: { id: accountId }, credentials: { secret: 'pw' } } as never),
  })
  await db.emails.put({
    accountId,
    id: 'm1',
    threadId: 't1',
    receivedAt: 0,
    mailboxIds: ['inbox'],
    mailboxDates: [],
    unread: 1,
    flagged: 0,
    payload: sealPlain(header('m1', subject)),
  })
  await db.contacts.put({
    accountId,
    id: 'c1',
    addressBookIds: ['ab'],
    sortKey: 'ada',
    payload: sealPlain({ id: 'c1', fullName: 'Ada' } as never),
  })
}

/**
 * What is really on disk.
 *
 * Straight through IndexedDB, past Dexie: the middleware decrypts on read
 * whenever the key is in memory, so reading the row the normal way answers
 * "is it readable", never "is it encrypted" — the question this is for.
 */
async function rawEmailPayload(accountId: string) {
  const row = await new Promise<unknown>((resolve) => {
    const req = indexedDB.open('mel')
    req.onsuccess = () => {
      const tx = req.result.transaction('emails', 'readonly')
      tx.objectStore('emails').get([accountId, 'm1']).onsuccess = function () {
        resolve(this.result)
        req.result.close()
      }
    }
  })
  return (row as { payload: { plain?: unknown; enc?: unknown } }).payload
}

beforeEach(async () => {
  lock()
  for (const id of [ACC, OTHER]) markAccountEncrypted(id, false)
  await db.keyring.clear()
  await db.accounts.clear()
  await db.emails.clear()
  await db.contacts.clear()
})

describe('turning encryption on', () => {
  it('rewrites what is already stored, not only what arrives later', async () => {
    /*
     * The mail that made someone want encryption is the mail already on the
     * device. Flipping the flag alone would leave every existing row in
     * plaintext while the app reported itself as encrypted.
     */
    await seed(ACC)

    await enableEncryption(ACC, PASS)

    const raw = await rawEmailPayload(ACC)
    expect(raw.plain).toBeUndefined()
    expect(raw.enc).toBeDefined()
    // And the subject is nowhere in the bytes.
    expect(JSON.stringify(raw)).not.toContain('Rechnung')
  })

  it('leaves the data readable through the middleware afterwards', async () => {
    await seed(ACC)

    await enableEncryption(ACC, PASS)

    const row = await db.emails.get([ACC, 'm1'])
    expect(openEnvelope(row!.payload).subject).toBe('Rechnung')
  })

  it('marks the account row too, so a reload knows to ask for the passphrase', async () => {
    await seed(ACC)

    await enableEncryption(ACC, PASS)

    expect((await db.accounts.get(ACC))!.encrypted).toBe(true)
  })

  it('reports its progress, so a long migration is not a frozen screen', async () => {
    await seed(ACC)
    const seen: Array<[number, number]> = []

    await enableEncryption(ACC, PASS, (done, total) => seen.push([done, total]))

    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)![0]).toBe(seen.at(-1)![1])
  })

  it('refuses to run twice over the same account', async () => {
    // A second keyring would orphan the first, and with it every row the
    // first one sealed.
    await seed(ACC)
    await enableEncryption(ACC, PASS)

    await expect(enableEncryption(ACC, 'anderes-passwort')).rejects.toThrow(/already encrypted/)
  })

  it('leaves another account on the same device alone', async () => {
    await seed(ACC)
    await seed(OTHER, 'Nicht betroffen')

    await enableEncryption(ACC, PASS)

    const raw = await rawEmailPayload(OTHER)
    expect(raw.plain).toBeDefined()
    expect((await db.accounts.get(OTHER))!.encrypted).toBe(false)
  })
})

describe('turning encryption off', () => {
  it('refuses without the passphrase, and changes nothing', async () => {
    await seed(ACC)
    await enableEncryption(ACC, PASS)
    lock(ACC)

    await expect(disableEncryption(ACC, 'falsch-falsch-falsch')).resolves.toBe(false)

    expect((await db.accounts.get(ACC))!.encrypted).toBe(true)
    expect((await rawEmailPayload(ACC)).enc).toBeDefined()
  })

  it('writes everything back as plaintext and drops the keyring', async () => {
    await seed(ACC)
    await enableEncryption(ACC, PASS)

    await expect(disableEncryption(ACC, PASS)).resolves.toBe(true)

    const raw = await rawEmailPayload(ACC)
    expect(raw.enc).toBeUndefined()
    expect((raw.plain as EmailHeader).subject).toBe('Rechnung')
    expect(await db.keyring.get(ACC)).toBeUndefined()
    expect((await db.accounts.get(ACC))!.encrypted).toBe(false)
  })

  it('round-trips without losing a row', async () => {
    // The migration touches every table; a table missed on the way out
    // leaves rows nothing can read once the keyring is gone.
    await seed(ACC)

    await enableEncryption(ACC, PASS)
    await disableEncryption(ACC, PASS)

    expect(openEnvelope((await db.contacts.get([ACC, 'c1']))!.payload).fullName).toBe('Ada')
    expect(openEnvelope((await db.emails.get([ACC, 'm1']))!.payload).subject).toBe('Rechnung')
  })
})

describe('what the app knows at startup', () => {
  it('reports the encrypted accounts as locked', async () => {
    // They are on disk as ciphertext with no key in memory yet; the unlock
    // gate is what this list puts on screen.
    await seed(ACC)
    await seed(OTHER)
    await enableEncryption(ACC, PASS)
    lock()
    for (const id of [ACC, OTHER]) markAccountEncrypted(id, false)

    const { lockedAccountIds } = await initEncryptionState()

    expect(lockedAccountIds).toEqual([ACC])
    expect(isAccountEncrypted(ACC)).toBe(true)
  })

  it('opens an encrypted account again with its passphrase', async () => {
    await seed(ACC)
    await enableEncryption(ACC, PASS)
    lock(ACC)

    await expect(unlockAccount(ACC, 'falsch-falsch-falsch')).resolves.toBe(false)
    await expect(unlockAccount(ACC, PASS)).resolves.toBe(true)
    expect(openEnvelope((await db.emails.get([ACC, 'm1']))!.payload).subject).toBe('Rechnung')
  })
})
