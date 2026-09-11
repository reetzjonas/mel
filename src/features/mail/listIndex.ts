import { db, type AccountScopedKey } from '../../storage/db'
import { mailboxDateRange, threadOfKey } from '../../storage/emailRow'

/*
 * The two reads the grouped mail list is built on, both scoped to what is on
 * screen rather than to the account.
 *
 * This used to be an account-wide thread index: every message of every folder
 * paired with its conversation, scanned once per page load and then patched
 * from Dexie's table hooks. It was correct and it was cached, but the build
 * itself sat on the critical path of the first folder opened — 548ms on a
 * 36k-message account, split roughly into 100ms of `getAllKeys`, 200ms of
 * cursor over 9,011 distinct threads, and 250ms of building two maps with 36k
 * entries in them. The last part is what made caching the wrong answer: no
 * index can make JavaScript fill a 36k-entry Map quickly.
 *
 * What the list renders is about a hundred conversations. So that is what gets
 * read. Both functions touch index keys only — no payload, so they work while
 * the account is sealed.
 */

/**
 * The folder's conversations, newest message first, stopping once `want` of
 * them have been found.
 *
 * Walks the derived `mailboxDates` index, which is already in date order and
 * carries the thread in the key — so the conversation of each message is known
 * without reading the record. A folder of 28k messages is not scanned; the
 * cursor stops after the few hundred entries it takes to collect `want`
 * distinct threads.
 *
 * Raw IndexedDB because Dexie cannot hand out the index key next to the
 * primary key, and both are needed: one says which conversation, the other
 * which message and which account.
 */
export async function readThreadWindow(
  accountId: string,
  mailboxId: string,
  want: number,
  keep?: (id: string) => boolean,
): Promise<{ threadOrder: string[]; exhausted: boolean }> {
  await db.open()
  const idb = db.backendDB()
  const [from, to] = mailboxDateRange(mailboxId)
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('emails', 'readonly')
    const index = tx.objectStore('emails').index('mailboxDates')
    const scan = index.openKeyCursor(IDBKeyRange.bound(from, to))
    const seen = new Set<string>()
    const threadOrder: string[] = []

    scan.onsuccess = () => {
      const cursor = scan.result
      if (!cursor || threadOrder.length >= want) return
      // Mailbox ids are only unique per account, and the index key carries no
      // account — the primary key is what says whose folder this is.
      const [rowAccount, id] = cursor.primaryKey as AccountScopedKey
      const threadId = rowAccount === accountId ? threadOfKey(cursor.key as string) : null
      if (threadId && !seen.has(threadId) && (!keep || keep(id))) {
        seen.add(threadId)
        threadOrder.push(threadId)
      }
      cursor.continue()
    }

    // Exhausted means the folder holds no further conversation — which is
    // what tells the list there is nothing left to page in. Without it, a
    // window that happens to be full looks exactly like the end of the folder.
    tx.oncomplete = () => resolve({ threadOrder, exhausted: threadOrder.length < want })
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * Every message of each of those conversations, in any folder.
 *
 * Account-wide on purpose, and this is the part that cannot be folder-scoped:
 * a conversation's count and participants include the replies sitting in Sent.
 * It is cheap because it is asked for a hundred threads, not for all of them —
 * one small range read each, in a single transaction.
 */
export async function readThreadMembers(
  accountId: string,
  threadIds: readonly string[],
): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>()
  if (!threadIds.length) return members
  await db.open()
  const idb = db.backendDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('emails', 'readonly')
    const index = tx.objectStore('emails').index('[accountId+threadId]')
    for (const threadId of threadIds) {
      const request = index.getAllKeys(IDBKeyRange.only([accountId, threadId]))
      request.onsuccess = () => {
        members.set(
          threadId,
          (request.result as AccountScopedKey[]).map((key) => key[1]),
        )
      }
    }
    tx.oncomplete = () => resolve(members)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
