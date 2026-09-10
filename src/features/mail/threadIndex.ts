import { db, type AccountScopedKey, type EmailRow } from '../../storage/db'

/**
 * Which messages belong to which thread, account-wide.
 *
 * Grouping the mail list needs this for the whole account, not just the folder
 * on screen: a conversation spans folders, so a row's count and participants
 * include the replies sitting in Sent.
 */
export interface ThreadIndex {
  /** threadId → the ids of every message of that thread, in any mailbox. */
  members: Map<string, string[]>
  /** id → threadId, for the messages of this account. */
  threadOf: Map<string, string>
}

/*
 * Built once per account and kept current from Dexie's table hooks.
 *
 * Rebuilding it per folder open was the whole reason opening a folder took
 * seconds. Measured in Chromium against a 36k-message account: the scan below
 * costs ~380ms (the pairing it replaced, ~1.2s), and since it covers the
 * account rather than the folder, an *empty* folder used to cost exactly as
 * much as the big one — 1.4s either way, against ~0.25s with grouping off.
 * The index does not depend on the folder, so switching folders has no reason
 * to recompute it: the scan happens once and every later change is a Map patch
 * of the single row that changed.
 */
let cached: { accountId: string; index: ThreadIndex } | null = null
let building: { accountId: string; promise: Promise<ThreadIndex> } | null = null
/** Row changes that arrived while the scan was running (see `patch`). */
let buffered: ((index: ThreadIndex) => void)[] | null = null
let hooked = false

const RANGE_END = '￿'

/**
 * Splits the primary keys of the `[accountId+threadId]` range into threads.
 *
 * `ids` is ordered by IndexedDB as (threadId, id) — an index is sorted by its
 * key and then by primary key — so each thread's messages are contiguous and
 * begin with the thread's lowest id. `firstIdOf` maps exactly those lowest ids
 * to their thread, which is all that is needed to cut the array up: no key has
 * to be read per row.
 *
 * Returns null if the two reads it is given do not line up. That cannot happen
 * when both come from one transaction, but guessing here would attribute
 * messages to the wrong thread, so the caller pairs them the expensive way
 * instead.
 */
export function splitThreads(ids: string[], firstIdOf: Map<string, string>): ThreadIndex | null {
  const index: ThreadIndex = { members: new Map(), threadOf: new Map() }
  let list: string[] | null = null
  let threadId: string | null = null
  for (const id of ids) {
    const starts = firstIdOf.get(id)
    if (starts !== undefined) {
      threadId = starts
      list = []
      index.members.set(starts, list)
    }
    if (!list || threadId === null) return null
    list.push(id)
    index.threadOf.set(id, threadId)
  }
  return index.members.size === firstIdOf.size ? index : null
}

/**
 * One read transaction holding both scans: the whole range's primary keys via
 * `getAllKeys`, and one cursor step per *distinct* thread (`nextunique`), which
 * reports the thread together with its first primary key.
 *
 * Raw IndexedDB rather than Dexie for two reasons: Dexie has no way to expose
 * `primaryKey` on a unique-key scan, and `getAllKeys` is what makes this cheap
 * — Dexie's `keys()` has no such fast path and walks the cursor row by row.
 * Only keys are read, never a record, so the crypto middleware this bypasses
 * has nothing to do here anyway.
 */
async function readRange(
  accountId: string,
): Promise<{ ids: string[]; firstIdOf: Map<string, string> }> {
  await db.open()
  const idb = db.backendDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('emails', 'readonly')
    const index = tx.objectStore('emails').index('[accountId+threadId]')
    const range = IDBKeyRange.bound([accountId, ''], [accountId, RANGE_END])
    const firstIdOf = new Map<string, string>()
    let ids: string[] = []

    const all = index.getAllKeys(range)
    all.onsuccess = () => {
      ids = (all.result as AccountScopedKey[]).map((key) => key[1])
    }
    const scan = index.openKeyCursor(range, 'nextunique')
    scan.onsuccess = () => {
      const cursor = scan.result
      if (!cursor) return
      const id = (cursor.primaryKey as AccountScopedKey)[1]
      const threadId = (cursor.key as [string, string])[1]
      firstIdOf.set(id, threadId)
      cursor.continue()
    }

    tx.oncomplete = () => resolve({ ids, firstIdOf })
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * The fallback: two scans of the same range, pairing index keys with primary
 * keys by position. Correct but slow — `keys()` walks a cursor — and it only
 * runs if `splitThreads` found the cheap reads inconsistent.
 */
async function pairByCursor(accountId: string): Promise<ThreadIndex> {
  return db.transaction('r', db.emails, async () => {
    const range = () =>
      db.emails.where('[accountId+threadId]').between([accountId, ''], [accountId, RANGE_END])
    const [keys, primary] = await Promise.all([range().keys(), range().primaryKeys()])
    const index: ThreadIndex = { members: new Map(), threadOf: new Map() }
    for (let i = 0; i < primary.length; i++) {
      const threadId = (keys[i] as [string, string] | undefined)?.[1]
      const id = primary[i]?.[1]
      if (threadId === undefined || id === undefined) continue
      add(index, id, threadId)
    }
    return index
  })
}

async function scan(accountId: string): Promise<ThreadIndex> {
  const { ids, firstIdOf } = await readRange(accountId)
  return splitThreads(ids, firstIdOf) ?? pairByCursor(accountId)
}

/** Idempotent: a row can be both scanned and reported by a racing hook. */
function add(index: ThreadIndex, id: string, threadId: string): void {
  index.threadOf.set(id, threadId)
  const list = index.members.get(threadId)
  if (!list) index.members.set(threadId, [id])
  else if (!list.includes(id)) list.push(id)
}

function remove(index: ThreadIndex, id: string, threadId: string): void {
  index.threadOf.delete(id)
  const list = index.members.get(threadId)
  if (!list) return
  const at = list.indexOf(id)
  if (at !== -1) list.splice(at, 1)
  if (!list.length) index.members.delete(threadId)
}

/**
 * Applies one row change, or parks it until the running scan has finished — a
 * patch applied before the maps exist would be lost, and one applied to a
 * half-built index would be undone by the rest of the scan.
 */
function patch(accountId: string, apply: (index: ThreadIndex) => void): void {
  if (cached?.accountId === accountId) apply(cached.index)
  else if (buffered && building?.accountId === accountId) buffered.push(apply)
}

/*
 * The hooks fire *inside* the write transaction, so an aborted transaction
 * leaves the index describing a write that never landed. The mail list has
 * always been built on that assumption — its own header cache is patched from
 * the same hooks — and a failed write is followed by a sync that corrects the
 * rows, and with them this index.
 */
function installHooks(): void {
  if (hooked) return
  hooked = true

  db.emails.hook('creating', (_key: AccountScopedKey, row: EmailRow) => {
    patch(row.accountId, (index) => add(index, row.id, row.threadId))
  })

  db.emails.hook('updating', (mods: object, _key: AccountScopedKey, row: EmailRow) => {
    // `put()` on an existing key lands here with a diff keyed by dotted paths;
    // threadId is a column of its own, so a rethread shows up under that key.
    const changed = 'threadId' in mods ? (mods as { threadId?: unknown }).threadId : undefined
    const threadId = typeof changed === 'string' ? changed : row.threadId
    patch(row.accountId, (index) => {
      if (threadId !== row.threadId) remove(index, row.id, row.threadId)
      add(index, row.id, threadId)
    })
  })

  db.emails.hook('deleting', (_key: AccountScopedKey, row: EmailRow) => {
    if (!row) return
    patch(row.accountId, (index) => remove(index, row.id, row.threadId))
  })
}

/** The account's thread index: scanned once, reused and patched after that. */
export async function getThreadIndex(accountId: string): Promise<ThreadIndex> {
  installHooks()
  if (cached?.accountId === accountId) return cached.index
  if (building?.accountId === accountId) return building.promise

  const promise = (async () => {
    buffered = []
    try {
      const index = await scan(accountId)
      // Whatever was written while the scan ran is not in it yet.
      for (const apply of buffered) apply(index)
      cached = { accountId, index }
      return index
    } finally {
      buffered = null
      if (building?.accountId === accountId) building = null
    }
  })()
  building = { accountId, promise }
  return promise
}

/**
 * Drops the index. Needed wherever mail rows disappear without the table hooks
 * seeing it: `Collection.delete()` and `clear()` reach IndexedDB as a range
 * delete and report no rows, so signing out (and test setup) has to say so.
 */
export function resetThreadIndex(): void {
  cached = null
  building = null
  buffered = null
}
