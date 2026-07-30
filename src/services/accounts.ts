import type { Credentials } from '../domain/account'
import { providerFor } from '../providers/registry'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { syncAccount } from '../sync/engine'

/** Validate credentials, persist the account and kick off the initial sync. */
export async function addAccount(server: string, credentials: Credentials): Promise<string> {
  const localId = crypto.randomUUID()
  const conn = await providerFor('jmap').connect(server, credentials, localId)
  await db.accounts.put({
    id: localId,
    provider: 'jmap',
    encrypted: false,
    payload: sealPlain({ account: conn.account, credentials }),
  })
  void syncAccount(localId)
  return localId
}

export async function removeAccount(accountId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.accounts, db.syncState, db.mailboxes, db.emails, db.threads, db.bodyCache, db.blobCache, db.outbox],
    async () => {
      await db.accounts.delete(accountId)
      for (const table of [db.syncState, db.mailboxes, db.emails, db.threads, db.bodyCache, db.blobCache, db.outbox]) {
        await table.where('accountId').equals(accountId).delete()
      }
    },
  )
}
