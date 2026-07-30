import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { sealPlain } from '../envelope'
import {
  changePassphrase,
  dekFor,
  initKeyring,
  lock,
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
    expect((row?.payload as { plain?: { name: string } }).plain?.name).toBe('Geheim')
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
    expect((row?.payload as { plain?: { subject: string } }).plain?.subject).toBe('Streng geheim')

    // Locked → sealed.
    lock(ACC)
    const sealed = await db.emails.get([ACC, 'e1'])
    expect((sealed?.payload as { enc?: unknown }).enc).toBeDefined()
  })

  it('rejects ciphertext moved between tables (AAD binding)', async () => {
    await initKeyring(ACC, PASS)
    markAccountEncrypted(ACC, true)
    await db.emails.put({
      accountId: ACC,
      id: 'e2',
      threadId: 't1',
      mailboxIds: [],
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
    // Decryption must fail → payload stays sealed.
    expect((row?.payload as { plain?: unknown }).plain).toBeUndefined()
  })
})
