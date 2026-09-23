import type { Account, Credentials } from '../domain/account'
import { clearAppBadge } from '../lib/appBadge'
import { classifyConnectionError, type ConnectionError } from '../lib/netError'
import { TotpRequired, tokenLogin } from '../providers/jmap/client/auth'
import { fetchSession, sessionUrlFor } from '../providers/jmap/client/session'
import { JmapError } from '../providers/jmap/client/transport'
import { providerFor } from '../providers/registry'
import { db } from '../storage/db'
import { lockOwnKeys } from './pgpKeys'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor, dropConnection, storedAccount } from '../sync/connections'
import { syncAccount, syncSettled } from '../sync/engine'
import { startScheduler, stopScheduler } from '../sync/scheduler'

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
 * A password swapped for a refresh token where the server has a token login;
 * the credentials unchanged otherwise (another server, an API token).
 */
async function preferTokens(
  sessionUrl: string,
  credentials: Credentials,
  totp?: string,
): Promise<Credentials> {
  if (credentials.method !== 'basic' || !credentials.username) return credentials
  const tokens = await tokenLogin({
    sessionUrl,
    username: credentials.username,
    password: credentials.secret,
    totp,
  })
  return tokens ?? credentials
}

/**
 * Validate credentials, persist the account and kick off the initial sync.
 *
 * Candidates are tried in order. A 401/403 ends the walk immediately: that
 * server is the right one and the password is wrong, and trying the remaining
 * hosts would only replace a useful error with a misleading "not found". So
 * does a server asking for a TOTP code (`TotpRequired`), for the same reason.
 *
 * A password is traded for a refresh token first where the server offers
 * that, and only the token is stored (issue #97).
 */
export async function addAccount(
  candidates: string[],
  credentials: Credentials,
  totp?: string,
): Promise<string> {
  const localId = crypto.randomUUID()
  let conn
  let stored = credentials
  const tried: string[] = []
  let lastError: ConnectionError | null = null
  for (const candidate of candidates) {
    tried.push(candidate)
    try {
      stored = await preferTokens(sessionUrlFor(candidate), credentials, totp)
      conn = await providerFor('jmap').connect(candidate, stored, localId)
      break
    } catch (e) {
      if (e instanceof TotpRequired) throw e
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
    payload: sealPlain({ account: conn.account, credentials: stored }),
  })
  void syncAccount(localId)
  return localId
}

async function storeCredentials(accountId: string, credentials: Credentials): Promise<void> {
  const row = await db.accounts.get(accountId)
  if (!row) return
  const { account } = openEnvelope(row.payload)
  await db.accounts.put({ ...row, payload: sealPlain({ account, credentials }) })
}

/**
 * Signs an account in again after the server stopped taking its credentials —
 * a refresh token expired or revoked, a password changed — without touching
 * anything stored for it. Throws `TotpRequired` or an `auth` error like the
 * login does.
 */
export async function reauthenticate(
  accountId: string,
  secret: string,
  totp?: string,
): Promise<void> {
  const { account, credentials } = await storedAccount(accountId)
  const username = credentials.username ?? account.label
  const next: Credentials =
    credentials.method === 'bearer'
      ? { method: 'bearer', secret }
      : await preferTokens(account.sessionUrl, { method: 'basic', username, secret }, totp)
  // Checked before it replaces what is stored: a typo must not make things worse.
  await fetchSession(account.sessionUrl, next)
  await storeCredentials(accountId, next)
  await stopScheduler(accountId)
  dropConnection(accountId)
  startScheduler(accountId)
}

/**
 * Trades a stored password for a refresh token, once, where the server has
 * learnt the token login since the account was added (or mel has). Quietly
 * leaves Basic auth in place for anything short of success: a server without
 * the login, one asking for a TOTP code, or no network right now.
 */
export async function upgradeToTokens(accountId: string): Promise<void> {
  const { account, credentials } = await storedAccount(accountId)
  if (credentials.method !== 'basic' || !credentials.username) return
  let tokens: Credentials | null
  try {
    tokens = await tokenLogin({
      sessionUrl: account.sessionUrl,
      username: credentials.username,
      password: credentials.secret,
    })
  } catch {
    return
  }
  if (!tokens) return
  await storeCredentials(accountId, tokens)
  // The open connection keeps the password it was made with until the next
  // start; the next one is made from the token.
  dropConnection(accountId)
}

/**
 * Sign out: drop the stored credentials and every row this account owns.
 *
 * There is no server-side session to end — the credentials only ever lived in
 * IndexedDB — so removing them locally *is* the logout. (A refresh token stays
 * valid on the server until it expires: Stalwart offers no revocation
 * endpoint to hand it back to.) The per-account tables
 * must all be listed here; a forgotten one leaves a previous user's mail or
 * contacts readable to the next person who signs in on this device.
 */
export async function removeAccount(accountId: string): Promise<void> {
  const owned = [
    db.imageSenders,
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
    db.eventNotifications,
    db.submissions,
    db.pgpKeys,
    db.files,
    db.notes,
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
  // Await it: a tick that is mid-flush has not called syncAccount yet, so
  // syncSettled below cannot see it, and it would happily write a whole fresh
  // sync over the rows we are about to delete.
  await stopScheduler(accountId)
  await db.accounts.delete(accountId)
  dropConnection(accountId)
  await syncSettled(accountId)
  await removeAccount(accountId)
  lockOwnKeys(accountId)
  // The icon badge outlives the tab, so an unread count left behind would
  // keep pointing at mail this device no longer has.
  clearAppBadge()
}

/**
 * Ask the server what it can do right now, and store the answer.
 *
 * `connectionFor` already persists this for every connection it opens, but
 * that is once per app start — this is the "I just turned it on, show me"
 * button, so it drops the cached connection to force a fresh session rather
 * than reporting what the cached one was told at startup.
 */
export async function refreshCapabilities(accountId: string): Promise<Account> {
  dropConnection(accountId)
  const { account } = await connectionFor(accountId)
  return account
}

/**
 * Throw away the sync cursors and fetch everything again.
 *
 * A delta sync can only carry changes forward from its stored state, so it
 * cannot repair a local mirror that is missing rows — the server never
 * "changed" them. Dropping the cursors makes the next pass a full one, which
 * both refills the gaps and prunes anything the server no longer has.
 */
export async function resyncAccount(accountId: string): Promise<void> {
  await db.syncState.where('accountId').equals(accountId).delete()
  await syncAccount(accountId)
}
