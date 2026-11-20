import { db } from '../storage/db'
import {
  changePassphrase,
  dekFor,
  hasKeyring,
  initKeyring,
  lock,
  removeKeyring,
  unlock,
} from '../storage/crypto/keyring'
import { isAccountEncrypted, markSessionEncrypted, sessionOf } from '../storage/crypto/middleware'
import {
  accountsOfSession,
  loadAccountSessions,
  migrateLegacySessions,
  setSessionFlags,
} from '../storage/sessions'

export { changePassphrase, lock }

/** Tables migrated when toggling encryption (all rows of the account). */
const ACCOUNT_TABLES = [
  'imageSenders',
  'mailboxes',
  'emails',
  'threads',
  'bodyCache',
  'blobCache',
  'addressBooks',
  'contacts',
  'calendars',
  'events',
  'submissions',
  'pgpKeys',
] as const

/*
 * Encryption is per session: one passphrase and one key for a login and every
 * account it reaches (the keyring is keyed by the session id). An account
 * from before sessions is its own session under its own id, and until its
 * credentials have moved to a session row (storage/sessions.ts) its flag is
 * still on the account row; both are read.
 */

/** The sessions with encryption on, from the session rows and any account not yet moved. */
export async function encryptedSessionIds(): Promise<string[]> {
  const ids = new Set<string>()
  const sessionRows = await db.sessions.toArray()
  const known = new Set(sessionRows.map((r) => r.id))
  for (const row of sessionRows) if (row.encrypted) ids.add(row.id)
  for (const row of await db.accounts.toArray()) {
    const sessionId = row.sessionId ?? row.id
    if (row.encrypted && !known.has(sessionId)) ids.add(sessionId)
  }
  return [...ids]
}

/** Load the account→session map and the encrypted flags into the middleware. Call once at startup. */
export async function initEncryptionState(): Promise<{ lockedSessionIds: string[] }> {
  await loadAccountSessions()
  const locked = await encryptedSessionIds()
  for (const id of locked) markSessionEncrypted(id, true)
  return { lockedSessionIds: locked }
}

/** Unlock a session, and with it every account it reaches. */
export async function unlockSession(sessionId: string, passphrase: string): Promise<boolean> {
  return unlock(sessionId, passphrase)
}

/** Unlock the session an account is reached through. */
export async function unlockAccount(accountId: string, passphrase: string): Promise<boolean> {
  return unlockSession(sessionOf(accountId), passphrase)
}

/** The encrypted sessions whose key is not loaded. */
export async function lockedSessionIds(): Promise<string[]> {
  return (await encryptedSessionIds()).filter((id) => !dekFor(id))
}

async function rewriteSessionRows(
  sessionId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Rows pass through the middleware on write, which seals or opens them
  // according to the current encryption flag.
  const accountIds = await accountsOfSession(sessionId)
  let done = 0
  const total = accountIds.length * ACCOUNT_TABLES.length + 1
  for (const accountId of accountIds) {
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
  }
  const sessionRow = await db.sessions.get(sessionId)
  if (sessionRow) await db.sessions.put(sessionRow)
  onProgress?.(total, total)
}

/**
 * Enable at-rest encryption for the session an account is reached through,
 * and so for all its accounts: create the keyring, flip the flag, then stream
 * every row through the crypto middleware.
 */
export async function enableEncryption(
  accountId: string,
  passphrase: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const sessionId = sessionOf(accountId)
  if (await hasKeyring(sessionId)) throw new Error('already encrypted')
  // The flag is the session row's: one from before sessions gets its row first.
  await migrateLegacySessions()
  await initKeyring(sessionId, passphrase)
  markSessionEncrypted(sessionId, true)
  // Detailed push notifications go with it: from here on the service worker
  // cannot read the credentials it would need to fetch a message, so leaving
  // the flag set would only promise something that silently never happens.
  await setSessionFlags(sessionId, { encrypted: true, pushDetails: false })
  await rewriteSessionRows(sessionId, onProgress)
}

/** Disable encryption: decrypt everything back to plaintext, drop the keyring. */
export async function disableEncryption(
  accountId: string,
  passphrase: string,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const sessionId = sessionOf(accountId)
  if (!(await unlockSession(sessionId, passphrase))) return false
  // Flag off first so rewritten rows are stored as plaintext; reads still
  // decrypt because the DEK is unlocked.
  markSessionEncrypted(sessionId, false)
  await setSessionFlags(sessionId, { encrypted: false })
  await rewriteSessionRows(sessionId, onProgress)
  await removeKeyring(sessionId)
  return true
}

export { isAccountEncrypted }
