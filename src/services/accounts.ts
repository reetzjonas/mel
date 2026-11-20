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
import { connectionFor, dropConnection, dropSession } from '../sync/connections'
import { forgetAccount } from '../storage/crypto/middleware'
import { removeKeyring } from '../storage/crypto/keyring'
import { accountsOfSession, storeAccount, storedAccount, storedSession } from '../storage/sessions'
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
  let opened
  let stored = credentials
  const tried: string[] = []
  let lastError: ConnectionError | null = null
  for (const candidate of candidates) {
    tried.push(candidate)
    try {
      stored = await preferTokens(sessionUrlFor(candidate), credentials, totp)
      opened = await providerFor('jmap').openSession(
        sessionUrlFor(candidate),
        stored,
        crypto.randomUUID(),
      )
      break
    } catch (e) {
      if (e instanceof TotpRequired) throw e
      if (e instanceof JmapError && e.kind === 'auth') throw e
      // Anything else (DNS failure, CORS, 404, a non-JMAP host) → next guess.
      lastError = classifyConnectionError(e)
    }
  }
  if (!opened) throw new NoServerFound(tried, lastError)

  /*
   * The same login again (the same server, the same user) is the session
   * already here, signed in afresh: its credentials are replaced and anything
   * it has gained since is added. Anything else is a new session.
   */
  const existing = await sessionLike(opened.session.sessionUrl, opened.session.label)
  const sessionId = existing ?? opened.session.id
  await db.sessions.put({
    ...((existing && (await db.sessions.get(existing))) || {
      id: sessionId,
      provider: 'jmap',
      encrypted: false,
    }),
    payload: sealPlain({ session: { ...opened.session, id: sessionId }, credentials: stored }),
  })
  if (existing) await dropSession(existing)

  const have = new Map<string, string>()
  for (const id of await accountsOfSession(sessionId)) {
    try {
      have.set((await storedAccount(id)).account.remoteAccountId, id)
    } catch {
      // Unreadable (locked): treated as not there, and not added twice below.
    }
  }
  for (const remoteAccountId of opened.accounts) {
    if (have.has(remoteAccountId)) continue
    const conn = opened.account(sessionId, crypto.randomUUID(), remoteAccountId)
    await storeAccount(conn.account)
    have.set(remoteAccountId, conn.account.id)
    void syncAccount(conn.account.id)
  }
  // The session's primary account is the one shown first.
  return have.get(opened.accounts[0]!)!
}

/** A stored session for the same login, if there is one. */
async function sessionLike(sessionUrl: string, label: string): Promise<string | null> {
  for (const row of await db.sessions.toArray()) {
    try {
      const { session } = openEnvelope(row.payload)
      if (session.sessionUrl === sessionUrl && session.label === label) return row.id
    } catch {
      // Locked: cannot be compared.
    }
  }
  return null
}

async function storeCredentials(sessionId: string, credentials: Credentials): Promise<void> {
  const row = await db.sessions.get(sessionId)
  if (!row) return
  const { session } = openEnvelope(row.payload)
  await db.sessions.put({ ...row, payload: sealPlain({ session, credentials }) })
}

/** The session an account is reached through: a plaintext column, readable when locked. */
async function sessionOfAccount(accountId: string): Promise<string> {
  const row = await db.accounts.get(accountId)
  return row?.sessionId ?? accountId
}

/** Stop a session's accounts' sync, forget its connection, and start them again. */
async function restartSession(sessionId: string): Promise<void> {
  const ids = await accountsOfSession(sessionId)
  await Promise.all(ids.map(stopScheduler))
  await dropSession(sessionId)
  for (const id of ids) startScheduler(id)
}

/**
 * Signs a session in again after the server stopped taking its credentials —
 * a refresh token expired or revoked, a password changed — without touching
 * anything stored for it, for every account it reaches. Takes any one of
 * those accounts. Throws `TotpRequired` or an `auth` error like the login does.
 */
export async function reauthenticate(
  accountId: string,
  secret: string,
  totp?: string,
): Promise<void> {
  const sessionId = await sessionOfAccount(accountId)
  const { session, credentials } = await storedSession(sessionId)
  const username = credentials.username ?? session.label
  const next: Credentials =
    credentials.method === 'bearer'
      ? { method: 'bearer', secret }
      : await preferTokens(session.sessionUrl, { method: 'basic', username, secret }, totp)
  // Checked before it replaces what is stored: a typo must not make things worse.
  await fetchSession(session.sessionUrl, next)
  await storeCredentials(sessionId, next)
  await restartSession(sessionId)
}

/**
 * Trades a stored password for a refresh token, once, where the server has
 * learnt the token login since the account was added (or mel has). Quietly
 * leaves Basic auth in place for anything short of success: a server without
 * the login, one asking for a TOTP code, or no network right now.
 */
export async function upgradeToTokens(sessionId: string): Promise<void> {
  const { session, credentials } = await storedSession(sessionId)
  if (credentials.method !== 'basic' || !credentials.username) return
  let tokens: Credentials | null
  try {
    tokens = await tokenLogin({
      sessionUrl: session.sessionUrl,
      username: credentials.username,
      password: credentials.secret,
    })
  } catch {
    return
  }
  if (!tokens) return
  await storeCredentials(sessionId, tokens)
  // The open connections keep the password they were made with until the
  // next start; the next ones are made from the token.
  await dropSession(sessionId)
}

/**
 * Drop every row an account owns.
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
  await db.transaction('rw', [db.accounts, ...owned], async () => {
    await db.accounts.delete(accountId)
    for (const table of owned) {
      await table.where('accountId').equals(accountId).delete()
    }
  })
  forgetAccount(accountId)
}

/**
 * The single entry point for logging out: of the session the account is
 * reached through, which takes every account of that login with it. The
 * credentials are the session's, so that is what signing out can mean.
 *
 * There is no server-side session to end — the credentials only ever lived in
 * IndexedDB — so removing them locally *is* the logout. (A refresh token stays
 * valid on the server until it expires: Stalwart offers no revocation
 * endpoint to hand it back to.)
 *
 * Order matters. A sync that is already running holds a *cached* provider
 * connection, so it happily keeps writing mail rows after a wipe — signing out
 * mid-sync used to leave data behind. So: delete the session and account rows
 * first (nothing can open a fresh connection without them), drop the cached
 * ones, wait for the in-flight passes to finish, and only then purge what they
 * wrote.
 */
export async function signOut(accountId: string): Promise<void> {
  const sessionId = await sessionOfAccount(accountId)
  const ids = await accountsOfSession(sessionId)
  if (!ids.includes(accountId)) ids.push(accountId)
  // Await it: a tick that is mid-flush has not called syncAccount yet, so
  // syncSettled below cannot see it, and it would happily write a whole fresh
  // sync over the rows we are about to delete.
  await Promise.all(ids.map(stopScheduler))
  await db.transaction('rw', db.sessions, db.accounts, async () => {
    await db.sessions.delete(sessionId)
    await db.accounts.bulkDelete(ids)
  })
  await dropSession(sessionId)
  for (const id of ids) dropConnection(id)
  for (const id of ids) {
    await syncSettled(id)
    await removeAccount(id)
    lockOwnKeys(id)
  }
  await removeKeyring(sessionId)
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
  await dropSession(await sessionOfAccount(accountId))
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
