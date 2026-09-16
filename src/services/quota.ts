import type { StorageQuota } from '../domain/quota'
import { connectionFor } from '../sync/connections'

/**
 * What the account has stored on the server, or null when nothing limits it.
 *
 * Read straight from the server rather than mirrored into IndexedDB: the number
 * is one small field, it is meaningless offline, and it changes with every
 * write the account makes anywhere — a cached copy would be wrong more often
 * than right.
 */
export async function storageQuota(accountId: string): Promise<StorageQuota | null> {
  const { quota } = await connectionFor(accountId)
  return quota ? quota.storage() : null
}
