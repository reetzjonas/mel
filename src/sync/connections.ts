import type { Account, Credentials } from '../domain/account'
import { providerFor } from '../providers/registry'
import type { ProviderConnection } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'

const cache = new Map<string, Promise<ProviderConnection>>()

export async function storedAccount(
  accountId: string,
): Promise<{ account: Account; credentials: Credentials }> {
  const row = await db.accounts.get(accountId)
  if (!row) throw new Error(`Account ${accountId} not found`)
  return openEnvelope(row.payload)
}

/** Open (or reuse) a provider connection for a stored account. */
export function connectionFor(accountId: string): Promise<ProviderConnection> {
  let conn = cache.get(accountId)
  if (!conn) {
    conn = storedAccount(accountId).then(({ account, credentials }) =>
      providerFor(account.provider).open(account, credentials),
    )
    conn.catch(() => cache.delete(accountId))
    cache.set(accountId, conn)
  }
  return conn
}

export function dropConnection(accountId: string) {
  cache.delete(accountId)
}
