import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { mailboxDateKey } from './emailRow'

/*
 * The schema upgrade that backfills the derived folder index.
 *
 * Worth its own test for a reason the other storage tests do not share: this
 * runs exactly once per device, unattended, while the app starts after an
 * update. If it throws, Dexie fails to open the database and there is no
 * screen left to report it on — and nobody can re-run it to find out.
 *
 * What it has to survive is an *encrypted, locked* account: the passphrase has
 * not been entered yet when the upgrade runs, so there is no key. `modify()`
 * is a read followed by a write, and the crypto middleware throws on a write
 * to a locked encrypted account (middleware.ts, "write to locked encrypted
 * account"). It gets away with it because the row it hands back is still
 * sealed — `payload.enc`, no `payload.plain` — and sealRow returns early on
 * exactly that. Two files, one line apart from disaster, with nothing
 * connecting them until now.
 *
 * Both modules are imported dynamically, and db first: db.ts and
 * crypto/keyring.ts import each other, and entering that cycle through the
 * middleware leaves cryptoMiddleware undefined at the moment db.ts installs
 * it. Constructing MelDb does not open anything, so importing it early costs
 * nothing.
 */

const ACC = 'acc-1'
const OLD_DB = 'mel'

/** The schema as it stood at version 3, before the derived column existed. */
function legacyDb() {
  const db = new Dexie(OLD_DB)
  db.version(1).stores({
    accounts: '&id',
    syncState: '&[accountId+collection]',
    mailboxes: '&[accountId+id], accountId, [accountId+parentId], [accountId+role]',
    emails:
      '&[accountId+id], [accountId+threadId], [accountId+receivedAt], *mailboxIds, [accountId+unread], [accountId+flagged]',
    threads: '&[accountId+id], [accountId+latestAt]',
    bodyCache: '&[accountId+emailId], lastAccess',
    blobCache: '&[accountId+blobId], lastAccess',
    outbox: '++seq, accountId, status, notBefore',
    keyring: '&accountId',
  })
  db.version(2).stores({
    addressBooks: '&[accountId+id], accountId',
    contacts: '&[accountId+id], accountId, *addressBookIds, [accountId+sortKey]',
  })
  db.version(3).stores({
    calendars: '&[accountId+id], accountId',
    events: '&[accountId+id], accountId, *calendarIds',
  })
  return db
}

/*
 * Stand-in ciphertext. No key is loaded in this test — that is the whole
 * point — so nothing ever tries to open it, and what these bytes decrypt to
 * is irrelevant. What matters is the shape: a payload carrying `enc` and no
 * `plain`, which is what a row of an encrypted account looks like on disk.
 */
const sealed = () => ({
  enc: { v: 1, iv: new Uint8Array(12).fill(7), ct: new Uint8Array(16).fill(9) },
})

/**
 * The byte values of something read back out of storage.
 *
 * fake-indexeddb's structured clone does not preserve the typed-array type —
 * a Uint8Array comes back as a plain {0: n, 1: n, …}. That is the test
 * environment's doing, not the app's, so the comparison is on the values.
 */
const bytes = (v: unknown): number[] => Object.values(v as Record<string, number>)

/** What is really on disk, past Dexie and past the middleware. */
async function rawEmail(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const req = indexedDB.open(OLD_DB)
    req.onsuccess = () => {
      const tx = req.result.transaction('emails', 'readonly')
      tx.objectStore('emails').get([ACC, 'm1']).onsuccess = function () {
        resolve(this.result as Record<string, unknown>)
        req.result.close()
      }
    }
  })
}

describe('upgrading a database written by an older version', () => {
  it('backfills the folder index of a locked, encrypted account without opening it', async () => {
    // First, so the import cycle is entered the way the app enters it. This
    // constructs the database object without opening it.
    const { db } = await import('./db')
    const { markAccountEncrypted } = await import('./crypto/middleware')

    const old = legacyDb()
    await old.open()
    await old.table('emails').put({
      accountId: ACC,
      id: 'm1',
      threadId: 't-9',
      receivedAt: 1_700_000_000_000,
      mailboxIds: ['mb-inbox', 'mb-label'],
      unread: 1,
      flagged: 0,
      payload: sealed(),
      // No mailboxDates: the column did not exist yet. That is what the
      // upgrade is for.
    })
    old.close()

    // Encrypted and locked, which is the state an upgrade actually meets: the
    // app starts, migrates, and only then asks for the passphrase.
    markAccountEncrypted(ACC, true)

    // Opening is what runs the upgrade. A throw here is the failure mode that
    // leaves someone with an app that will not start.
    await expect(db.open()).resolves.toBeDefined()

    const row = await rawEmail()

    // The index is filled, for every folder the message sits in.
    expect(row['mailboxDates']).toEqual([
      mailboxDateKey('mb-inbox', 1_700_000_000_000, 't-9'),
      mailboxDateKey('mb-label', 1_700_000_000_000, 't-9'),
    ])

    /*
     * And the payload came through untouched. Re-sealing it would have needed
     * a key there was none of; had the middleware tried, the upgrade would
     * have thrown rather than quietly corrupting it — but pinning the bytes
     * catches both, including a future middleware that fails softly.
     */
    const payload = row['payload'] as { plain?: unknown; enc?: { iv: unknown; ct: unknown } }
    expect(payload.plain).toBeUndefined()
    expect(bytes(payload.enc!.iv)).toEqual(Array(12).fill(7))
    expect(bytes(payload.enc!.ct)).toEqual(Array(16).fill(9))

    markAccountEncrypted(ACC, false)
    db.close()
  })
})
