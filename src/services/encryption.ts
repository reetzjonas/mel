import { db } from '../storage/db'
import {
  changePassphrase,
  hasKeyring,
  initKeyring,
  lock,
  removeKeyring,
  unlock,
} from '../storage/crypto/keyring'
import { isAccountEncrypted, markAccountEncrypted } from '../storage/crypto/middleware'

export { changePassphrase, lock }

/** Tables migrated when toggling encryption (all rows of the account). */
const ACCOUNT_TABLES = [
  'mailboxes',
  'emails',
  'threads',
  'bodyCache',
  'blobCache',
  'addressBooks',
  'contacts',
  'calendars',
  'events',
] as const

/** Load the encrypted-flag set into the middleware. Call once at startup. */
export async function initEncryptionState(): Promise<{ lockedAccountIds: string[] }> {
  const rows = await db.accounts.toArray()
  const locked: string[] = []
  for (const row of rows) {
    if (row.encrypted) {
      markAccountEncrypted(row.id, true)
      locked.push(row.id)
    }
  }
  return { lockedAccountIds: locked }
}

export async function unlockAccount(accountId: string, passphrase: string): Promise<boolean> {
  return unlock(accountId, passphrase)
}

async function rewriteAccountRows(
  accountId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Rows pass through the middleware on write, which seals or opens them
  // according to the current encryption flag.
  let done = 0
  const total = ACCOUNT_TABLES.length + 1
  for (const name of ACCOUNT_TABLES) {
    const table = db.table(name)
    const rows = await table.where('accountId').equals(accountId).toArray()
    if (rows.length) await table.bulkPut(rows)
    onProgress?.(++done, total)
  }
  const outboxRows = (await db.outbox.where('accountId').equals(accountId).toArray()).filter(
    (r) => r.status !== 'inflight',
  )
  if (outboxRows.length) await db.outbox.bulkPut(outboxRows)
  const accountRow = await db.accounts.get(accountId)
  if (accountRow) await db.accounts.put(accountRow)
  onProgress?.(total, total)
}

/**
 * Enable at-rest encryption for an account: create the keyring, flip the
 * flag, then stream every row through the crypto middleware.
 */
export async function enableEncryption(
  accountId: string,
  passphrase: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (await hasKeyring(accountId)) throw new Error('already encrypted')
  await initKeyring(accountId, passphrase)
  markAccountEncrypted(accountId, true)
  const row = await db.accounts.get(accountId)
  if (row) await db.accounts.put({ ...row, encrypted: true })
  await rewriteAccountRows(accountId, onProgress)
}

/** Disable encryption: decrypt everything back to plaintext, drop the keyring. */
export async function disableEncryption(
  accountId: string,
  passphrase: string,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  if (!(await unlockAccount(accountId, passphrase))) return false
  // Flag off first so rewritten rows are stored as plaintext; reads still
  // decrypt because the DEK is unlocked.
  markAccountEncrypted(accountId, false)
  const row = await db.accounts.get(accountId)
  if (row) await db.accounts.put({ ...row, encrypted: false })
  await rewriteAccountRows(accountId, onProgress)
  await removeKeyring(accountId)
  return true
}

export { isAccountEncrypted }
