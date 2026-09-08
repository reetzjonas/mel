import type { Credentials } from '../domain/account'
import { classifyConnectionError, type ConnectionError } from '../lib/netError'
import { JmapError } from '../providers/jmap/client/transport'
import { providerFor } from '../providers/registry'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { dropConnection } from '../sync/connections'
import { syncAccount, syncSettled } from '../sync/engine'
import { stopScheduler } from '../sync/scheduler'

/** No candidate answered — the caller can offer the user a wider search. */
export class NoServerFound extends Error {
  readonly tried: string[]
  /**
   * Why the last candidate failed. A browser cannot tell a CORS rejection from
   * a DNS miss, so this is kept and surfaced verbatim rather than flattened
   * into "not found" — for a server that exists but forgot its CORS headers,
   * "not found" sends the user hunting in entirely the wrong place.
   */
  readonly lastError: ConnectionError | null

  constructor(tried: string[], lastError: ConnectionError | null) {
    super('no JMAP server found')
    this.name = 'NoServerFound'
    this.tried = tried
    this.lastError = lastError
  }
}

/**
 * Validate credentials, persist the account and kick off the initial sync.
 *
 * Candidates are tried in order. A 401/403 ends the walk immediately: that
 * server is the right one and the password is wrong, and trying the remaining
 * hosts would only replace a useful error with a misleading "not found".
 */
export async function addAccount(
  candidates: string[],
  credentials: Credentials,
): Promise<string> {
  const localId = crypto.randomUUID()
  let conn
  const tried: string[] = []
  let lastError: ConnectionError | null = null
  for (const candidate of candidates) {
    tried.push(candidate)
    try {
      conn = await providerFor('jmap').connect(candidate, credentials, localId)
      break
    } catch (e) {
      if (e instanceof JmapError && e.kind === 'auth') throw e
      // Anything else (DNS failure, CORS, 404, a non-JMAP host) → next guess.
      lastError = classifyConnectionError(e)
    }
  }
  if (!conn) throw new NoServerFound(tried, lastError)
  await db.accounts.put({
    id: localId,
    provider: 'jmap',
    encrypted: false,
    payload: sealPlain({ account: conn.account, credentials }),
  })
  void syncAccount(localId)
  return localId
}

/**
 * Sign out: drop the stored credentials and every row this account owns.
 *
 * There is no server-side session to end — the credentials only ever lived in
 * IndexedDB — so removing them locally *is* the logout. The per-account tables
 * must all be listed here; a forgotten one leaves a previous user's mail or
 * contacts readable to the next person who signs in on this device.
 */
export async function removeAccount(accountId: string): Promise<void> {
  const owned = [
    db.syncState,
    db.mailboxes,
    db.emails,
    db.threads,
    db.bodyCache,
    db.blobCache,
    db.outbox,
    db.addressBooks,
    db.contacts,
    db.calendars,
    db.events,
  ]
  await db.transaction('rw', [db.accounts, db.keyring, ...owned], async () => {
    await db.accounts.delete(accountId)
    await db.keyring.delete(accountId)
    for (const table of owned) {
      await table.where('accountId').equals(accountId).delete()
    }
  })
}

/**
 * The single entry point for logging out.
 *
 * Order matters. A sync that is already running holds a *cached* provider
 * connection, so it happily keeps writing mail rows after a wipe — signing out
 * mid-sync used to leave data behind. So: delete the account row first (nothing
 * can open a fresh connection without it), drop the cached one, wait for the
 * in-flight pass to finish, and only then purge what it wrote.
 */
export async function signOut(accountId: string): Promise<void> {
  stopScheduler(accountId)
  await db.accounts.delete(accountId)
  dropConnection(accountId)
  await syncSettled(accountId)
  await removeAccount(accountId)
}
