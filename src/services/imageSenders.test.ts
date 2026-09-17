import { beforeEach, expect, it } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { lock } from '../storage/crypto/keyring'
import { markAccountEncrypted } from '../storage/crypto/middleware'
import { enableEncryption, disableEncryption, unlockAccount } from './encryption'
import { imageSenders, setImageSender } from './imageSenders'
import { removeAccount } from './accounts'

beforeEach(async () => {
  lock()
  for (const id of ['a', 'b']) markAccountEncrypted(id, false)
  await db.imageSenders.clear()
  await db.accounts.clear()
  await db.keyring.clear()
  for (const id of ['a', 'b']) {
    await db.accounts.put({
      id,
      provider: 'jmap',
      encrypted: false,
      payload: sealPlain({} as never),
    })
  }
})

it('defaults to blocking and keeps normalized exact addresses isolated per account', async () => {
  expect(await imageSenders('a')).toEqual([])
  await setImageSender('a', ' Alice@Example.com ', true)
  await setImageSender('a', 'alice@example.com', true)
  expect(await imageSenders('a')).toEqual(['alice@example.com'])
  expect(await imageSenders('b')).toEqual([])
  expect((await imageSenders('a')).includes('other@example.com')).toBe(false)
  await setImageSender('a', 'ALICE@example.com', false)
  expect(await imageSenders('a')).toEqual([])
  await setImageSender('a', ' ', true)
  expect(await imageSenders('a')).toEqual([])
})

it('serializes concurrent edits without losing senders', async () => {
  await Promise.all([
    setImageSender('a', 'one@example.com', true),
    setImageSender('a', 'two@example.com', true),
  ])
  expect(await imageSenders('a')).toEqual(['one@example.com', 'two@example.com'])
  await setImageSender('a', 'missing@example.com', false)
  expect(await imageSenders('a')).toHaveLength(2)
})

async function storedRow() {
  const native = db.backendDB()
  return new Promise<unknown>((resolve, reject) => {
    const req = native.transaction('imageSenders').objectStore('imageSenders').get('a')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

it('encrypts existing and new permissions, denies locked reads/writes, and decrypts on disable', async () => {
  await setImageSender('a', 'private@example.com', true)
  await enableEncryption('a', 'test-passphrase')
  expect(JSON.stringify(await storedRow())).not.toContain('private@example.com')
  expect(await storedRow()).toMatchObject({ accountId: 'a', payload: { enc: { v: 1 } } })
  await setImageSender('a', 'new@example.com', true)
  expect(JSON.stringify(await storedRow())).not.toContain('new@example.com')
  lock('a')
  expect(await imageSenders('a')).toEqual([])
  await expect(setImageSender('a', 'third@example.com', true)).rejects.toThrow()
  await unlockAccount('a', 'test-passphrase')
  expect(await imageSenders('a')).toEqual(['new@example.com', 'private@example.com'])
  await disableEncryption('a', 'test-passphrase')
  expect(await storedRow()).toMatchObject({
    payload: { plain: ['new@example.com', 'private@example.com'] },
  })
})

it('removes permissions on sign-out and rejects stale writes', async () => {
  await setImageSender('a', 'a@example.com', true)
  await setImageSender('b', 'b@example.com', true)
  await removeAccount('a')
  expect(await imageSenders('a')).toEqual([])
  expect(await imageSenders('b')).toEqual(['b@example.com'])
  await expect(setImageSender('a', 'late@example.com', true)).rejects.toThrow('Account not found')
})
