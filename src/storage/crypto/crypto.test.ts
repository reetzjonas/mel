import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { sealPlain } from '../envelope'
import {
  changePassphrase,
  dekFor,
  hasKeyring,
  initKeyring,
  lock,
  removeKeyring,
  unlock,
} from './keyring'
import { isAccountEncrypted, markAccountEncrypted } from './middleware'
import { deserialize, serialize } from './serialize'

const ACC = 'acc-test'
const PASS = 'korrekt pferd batterie klammer'

describe('serialize', () => {
  it('round-trips objects containing binary data', () => {
    const buf = new Uint8Array([1, 2, 3, 250]).buffer
    const value = { type: 'application/pdf', data: buf, nested: { u8: new Uint8Array([9, 8]) } }
    const out = deserialize<typeof value>(serialize(value))
    expect(out.type).toBe('application/pdf')
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array([1, 2, 3, 250]))
    expect(out.nested.u8).toEqual(new Uint8Array([9, 8]))
  })
})

describe('keyring', () => {
  beforeEach(async () => {
    lock()
    markAccountEncrypted(ACC, false)
    await db.keyring.delete(ACC)
  })

  it('init + unlock round-trip; wrong passphrase rejected', async () => {
    await initKeyring(ACC, PASS)
    lock(ACC)
    expect(dekFor(ACC)).toBeNull()
    expect(await unlock(ACC, 'falsch-falsch-falsch')).toBe(false)
    expect(await unlock(ACC, PASS)).toBe(true)
    expect(dekFor(ACC)).not.toBeNull()
  })

  it('changePassphrase re-wraps the DEK without touching data ciphertexts', async () => {
    await initKeyring(ACC, PASS)

    // Encrypt a row under the DEK via the middleware.
    markAccountEncrypted(ACC, true)
    await db.mailboxes.put({
      accountId: ACC,
      id: 'm1',
      parentId: null,
      role: 'inbox',
      sortOrder: 0,
      payload: sealPlain({ name: 'Geheim' }) as never,
    })
    const rawBefore = await new Promise<unknown>((resolve) => {
      const req = indexedDB.open('mel')
      req.onsuccess = () => {
        const tx = req.result.transaction('mailboxes', 'readonly')
        tx.objectStore('mailboxes').get([ACC, 'm1']).onsuccess = function () {
          resolve(this.result)
          req.result.close()
        }
      }
    })
    const ctBefore = (rawBefore as { payload: { enc: { ct: Uint8Array } } }).payload.enc.ct

    const ok = await changePassphrase(ACC, PASS, 'neues sicheres kennwort hier')
    expect(ok).toBe(true)

    lock(ACC)
    expect(await unlock(ACC, PASS)).toBe(false)
    expect(await unlock(ACC, 'neues sicheres kennwort hier')).toBe(true)

    // Data ciphertext unchanged (no re-encryption), still decryptable.
    const row = await db.mailboxes.get([ACC, 'm1'])
    expect(row).toBeDefined()
    const payload = row?.payload as { plain?: { name: string } } | undefined
    expect(payload?.plain?.name).toBe('Geheim')
    const rawAfter = await new Promise<unknown>((resolve) => {
      const req = indexedDB.open('mel')
      req.onsuccess = () => {
        const tx = req.result.transaction('mailboxes', 'readonly')
        tx.objectStore('mailboxes').get([ACC, 'm1']).onsuccess = function () {
          resolve(this.result)
          req.result.close()
        }
      }
    })
    const ctAfter = (rawAfter as { payload: { enc: { ct: Uint8Array } } }).payload.enc.ct
    expect(new Uint8Array(ctAfter)).toEqual(new Uint8Array(ctBefore))
  })
})

describe('locking, and what a keyring refuses', () => {
  beforeEach(async () => {
    lock()
    markAccountEncrypted(ACC, false)
    await db.keyring.delete(ACC)
  })

  it('leaves nothing usable in memory after locking', async () => {
    // The point of locking: a key still readable afterwards would make the
    // lock a label rather than a measure.
    await initKeyring(ACC, PASS)
    expect(dekFor(ACC)).not.toBeNull()

    lock(ACC)

    expect(dekFor(ACC)).toBeNull()
  })

  it('locks every account at once when asked for none in particular', async () => {
    const other = 'acc-2'
    await initKeyring(ACC, PASS)
    await initKeyring(other, PASS)

    lock()

    expect(dekFor(ACC)).toBeNull()
    expect(dekFor(other)).toBeNull()
    await db.keyring.delete(other)
  })

  it('refuses a passphrase change for an account that has no keyring', async () => {
    // Nothing to re-wrap; answering true would report a change that did not
    // happen and leave the caller believing the old passphrase is dead.
    expect(await changePassphrase(ACC, PASS, 'neu-neu-neu')).toBe(false)
  })

  it('refuses a passphrase change under the wrong old passphrase', async () => {
    await initKeyring(ACC, PASS)

    expect(await changePassphrase(ACC, 'falsch-falsch-falsch', 'neu-neu-neu')).toBe(false)
    // And the old one still opens it, since nothing was rewrapped.
    lock(ACC)
    expect(await unlock(ACC, PASS)).toBe(true)
  })

  it('knows whether an account has a keyring at all', async () => {
    expect(await hasKeyring(ACC)).toBe(false)
    await initKeyring(ACC, PASS)
    expect(await hasKeyring(ACC)).toBe(true)
  })

  it('removes the keyring and locks in the same breath', async () => {
    // Turning encryption off: a key left unlocked in memory would go on
    // decrypting rows that are plaintext again.
    await initKeyring(ACC, PASS)

    await removeKeyring(ACC)

    expect(await hasKeyring(ACC)).toBe(false)
    expect(dekFor(ACC)).toBeNull()
    // And unlocking is no longer possible, rather than quietly succeeding.
    expect(await unlock(ACC, PASS)).toBe(false)
  })
})

describe('crypto middleware', () => {
  beforeEach(async () => {
    lock()
    markAccountEncrypted(ACC, false)
    await db.keyring.delete(ACC)
    await db.emails.where('accountId').equals(ACC).delete()
  })

  it('stores sealed ciphertext and reads back plaintext when unlocked', async () => {
    await initKeyring(ACC, PASS)
    markAccountEncrypted(ACC, true)
    expect(isAccountEncrypted(ACC)).toBe(true)

    await db.emails.put({
      accountId: ACC,
      id: 'e1',
      threadId: 't1',
      mailboxIds: ['inbox'],
      mailboxDates: [],
      receivedAt: 1,
      unread: 1,
      flagged: 0,
      payload: sealPlain({ subject: 'Streng geheim' }) as never,
    })

    // Raw IndexedDB record must not contain the plaintext payload.
    const raw = await new Promise<unknown>((resolve) => {
      const req = indexedDB.open('mel')
      req.onsuccess = () => {
        const tx = req.result.transaction('emails', 'readonly')
        tx.objectStore('emails').get([ACC, 'e1']).onsuccess = function () {
          resolve(this.result)
          req.result.close()
        }
      }
    })
    const rawRow = raw as { payload: { plain?: unknown; enc?: { ct: Uint8Array } } }
    expect(rawRow.payload.plain).toBeUndefined()
    expect(rawRow.payload.enc).toBeDefined()
    expect(JSON.stringify(raw)).not.toContain('Streng geheim')

    // Through Dexie the row comes back decrypted.
    const row = await db.emails.get([ACC, 'e1'])
    expect(row).toBeDefined()
    const payload = row?.payload as { plain?: { subject: string } } | undefined
    expect(payload?.plain?.subject).toBe('Streng geheim')

    // Locked → sealed.
    lock(ACC)
    const sealed = await db.emails.get([ACC, 'e1'])
    expect(sealed).toBeDefined()
    const sealedPayload = sealed?.payload as { enc?: unknown } | undefined
    expect(sealedPayload?.enc).toBeDefined()
  })

  it('rejects ciphertext moved between tables (AAD binding)', async () => {
    await initKeyring(ACC, PASS)
    markAccountEncrypted(ACC, true)
    await db.emails.put({
      accountId: ACC,
      id: 'e2',
      threadId: 't1',
      mailboxIds: [],
      mailboxDates: [],
      receivedAt: 1,
      unread: 0,
      flagged: 0,
      payload: sealPlain({ subject: 'AAD-Test' }) as never,
    })
    const sealedRow = await new Promise<{ payload: unknown }>((resolve) => {
      const req = indexedDB.open('mel')
      req.onsuccess = () => {
        const tx = req.result.transaction('emails', 'readonly')
        tx.objectStore('emails').get([ACC, 'e2']).onsuccess = function () {
          resolve(this.result as { payload: unknown })
          req.result.close()
        }
      }
    })
    // Transplant the email ciphertext into the mailboxes table (raw write).
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('mel')
      req.onsuccess = () => {
        const tx = req.result.transaction('mailboxes', 'readwrite')
        tx.objectStore('mailboxes').put({
          accountId: ACC,
          id: 'evil',
          parentId: null,
          role: null,
          sortOrder: 0,
          payload: sealedRow.payload,
        })
        tx.oncomplete = () => {
          req.result.close()
          resolve()
        }
      }
    })
    const row = await db.mailboxes.get([ACC, 'evil'])
    expect(row).toBeDefined()
    // Decryption must fail → payload stays sealed.
    const payload = row?.payload as { plain?: unknown; enc?: unknown } | undefined
    expect(payload?.plain).toBeUndefined()
    expect(payload?.enc).toBeDefined()
  })
})
