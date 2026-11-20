import type { Account, Credentials } from '../domain/account'
import { onRefreshTokenRotated } from '../providers/jmap/client/auth'
import { providerFor } from '../providers/registry'
import type { ProviderConnection, ProviderSession } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { storeAccount, storedAccount, storedSession } from '../storage/sessions'

export { storedAccount }

/*
 * Open sessions and their accounts' connections.
 *
 * A session is fetched once per login and its accounts' connections are made
 * from it: one session resource, one transport, one credentials object. That
 * last one matters for a token login, which hands out a new refresh token on
 * renewal: every account of the login holds the same object, which is updated
 * in place, so none of them is left holding the token the server retired.
 */

const sessions = new Map<string, Promise<ProviderSession>>()
const connections = new Map<string, Promise<ProviderConnection>>()

/*
 * A renewal that came with a new refresh token: store it in place of the old
 * one, or the next start presents a token the server has retired.
 */
onRefreshTokenRotated((previous, credentials) => {
  void (async () => {
    for (const row of await db.sessions.toArray()) {
      const stored = openEnvelope(row.payload)
      if (stored.credentials.secret !== previous) continue
      await db.sessions.put({ ...row, payload: sealPlain({ ...stored, credentials }) })
    }
  })().catch(() => {})
})

/**
 * The session's accounts this device does not have yet, added: an account the
 * login has gained since (shared with it, delegated, pooled) shows up without
 * signing in again. One the session no longer lists is left alone — its
 * connection fails and says so — rather than wiped on the strength of one
 * session document.
 */
async function addNewAccounts(sessionId: string, opened: ProviderSession): Promise<void> {
  const have = new Set<string>()
  for (const row of await db.accounts.where('sessionId').equals(sessionId).toArray()) {
    try {
      have.add(openEnvelope(row.payload).account.remoteAccountId)
    } catch {
      return // locked: nothing to compare with until it is unlocked
    }
  }
  // Gone means signed out while this was opening: adding to it would bring
  // back accounts of a login just removed.
  if (!(await db.sessions.get(sessionId))) return
  for (const remoteAccountId of opened.accounts) {
    if (have.has(remoteAccountId)) continue
    const conn = opened.account(sessionId, crypto.randomUUID(), remoteAccountId)
    await storeAccount(conn.account)
  }
}

/** Open (or reuse) a stored session. */
export function sessionFor(sessionId: string): Promise<ProviderSession> {
  let open = sessions.get(sessionId)
  if (!open) {
    open = storedSession(sessionId).then(async ({ session, credentials }) => {
      const opened = await providerFor(session.provider).openSession(
        session.sessionUrl,
        credentials,
        sessionId,
      )
      await addNewAccounts(sessionId, opened).catch(() => {})
      return opened
    })
    open.catch(() => sessions.delete(sessionId))
    sessions.set(sessionId, open)
  }
  return open
}

/**
 * Write back what the session just said about this account.
 *
 * The stored account used to be whatever `addAccount` saw at login and never
 * moved again, so a capability the admin switched on afterwards stayed
 * invisible until the user signed out and back in. Every connection is built
 * from a fresh session, so that is the moment to persist it.
 *
 * Failure is deliberately swallowed: a connection is still perfectly usable
 * when only the write of its capability list failed, and taking the sync down
 * over that would be a far worse trade than one stale row.
 */
async function persistAccount(account: Account): Promise<void> {
  try {
    const row = await db.accounts.get(account.id)
    // Gone means signed out while this connection was still opening — writing
    // it back now would resurrect the account row we just deleted.
    if (!row) return
    await db.accounts.put({ ...row, payload: sealPlain({ account }) })
  } catch {
    // See above.
  }
}

/** Open (or reuse) a provider connection for a stored account. */
export function connectionFor(accountId: string): Promise<ProviderConnection> {
  let conn = connections.get(accountId)
  if (!conn) {
    conn = storedAccount(accountId).then(async ({ account }) => {
      const opened = await sessionFor(account.sessionId)
      const fresh = opened.account(account.sessionId, account.id, account.remoteAccountId)
      await persistAccount(fresh.account)
      return fresh
    })
    conn.catch(() => connections.delete(accountId))
    connections.set(accountId, conn)
  }
  return conn
}

export function dropConnection(accountId: string) {
  connections.delete(accountId)
}

/**
 * Forget an open session and its accounts' connections: the next use fetches
 * the session afresh, with the credentials as stored now.
 */
export async function dropSession(sessionId: string): Promise<void> {
  sessions.delete(sessionId)
  for (const id of await db.accounts.where('sessionId').equals(sessionId).primaryKeys()) {
    connections.delete(String(id))
  }
}

/** The credentials a session uses, for code that talks to it outside a connection. */
export async function sessionCredentials(sessionId: string): Promise<Credentials> {
  return (await storedSession(sessionId)).credentials
}
