import type { Account, Credentials } from '../domain/account'
import { onRefreshTokenRotated } from '../providers/jmap/client/auth'
import { providerFor } from '../providers/registry'
import type { ProviderConnection } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

const cache = new Map<string, Promise<ProviderConnection>>()

/*
 * A renewal that came with a new refresh token: store it in place of the old
 * one, or the next start presents a token the server has retired.
 */
onRefreshTokenRotated((previous, credentials) => {
  void (async () => {
    for (const row of await db.accounts.toArray()) {
      const stored = openEnvelope(row.payload)
      if (stored.credentials.secret !== previous) continue
      await db.accounts.put({ ...row, payload: sealPlain({ ...stored, credentials }) })
    }
  })().catch(() => {})
})

export async function storedAccount(
  accountId: string,
): Promise<{ account: Account; credentials: Credentials }> {
  const row = await db.accounts.get(accountId)
  if (!row) throw new Error(`Account ${accountId} not found`)
  return openEnvelope(row.payload)
}

/**
 * Write back what the session just said about this server.
 *
 * The stored account used to be whatever `addAccount` saw at login and never
 * moved again, so a capability the admin switched on afterwards stayed
 * invisible until the user signed out and back in. Every `open()` builds the
 * account from a fresh session, so that is the moment to persist it.
 *
 * Failure is deliberately swallowed: a connection is still perfectly usable
 * when only the write of its capability list failed, and taking the sync down
 * over that would be a far worse trade than one stale row.
 */
async function persistAccount(account: Account, credentials: Credentials): Promise<void> {
  try {
    const row = await db.accounts.get(account.id)
    // Gone means signed out while this connection was still opening — writing
    // it back now would resurrect the account row we just deleted.
    if (!row) return
    // The credentials as stored now, not as they were when this connection
    // set out: a token login or a re-sign-in may have replaced them since, and
    // writing the old ones back would restore a password just dropped.
    const current = openEnvelope(row.payload).credentials
    await db.accounts.put({
      ...row,
      payload: sealPlain({ account, credentials: current ?? credentials }),
    })
  } catch {
    // See above.
  }
}

/** Open (or reuse) a provider connection for a stored account. */
export function connectionFor(accountId: string): Promise<ProviderConnection> {
  let conn = cache.get(accountId)
  if (!conn) {
    conn = storedAccount(accountId).then(async ({ account, credentials }) => {
      const fresh = await providerFor(account.provider).open(account, credentials)
      await persistAccount(fresh.account, credentials)
      return fresh
    })
    conn.catch(() => cache.delete(accountId))
    cache.set(accountId, conn)
  }
  return conn
}

export function dropConnection(accountId: string) {
  cache.delete(accountId)
}
