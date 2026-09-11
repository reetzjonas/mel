# Hard-won gotchas: Dexie / IndexedDB performance (do not rediscover)

- **Dexie's `keys()` walks a cursor; `primaryKeys()` does not.** `primaryKeys()`
  has a `getAllKeys` fast path, `keys()` (and `each()`) has none, so it costs one
  IndexedDB round trip per row. Measured in Chromium on a 36k-message account:
  `keys()` 900ms versus 170ms for `getAllKeys` over the same range. That single
  call was ~85% of the cost of opening a folder (~1.4s grouped, ~0.25s with
  conversations off, both regardless of how much mail the folder held). Now
  ~0.8s for the first folder of a session — the one-time scan — and ~0.25s for
  every one after it. Reproduce with a synthetic account rather than guessing:
  inject rows straight into IndexedDB via Playwright and time the folder switch
  (`readOrder`/`materialise`/`publish` are easy to instrument in `refresh()`).
  Note this class of bug shows **no network activity at all** and is flat in the
  size of the folder — that is the fingerprint of an account-wide scan.
  The same trap sits in `.reverse()`: Dexie's `getAllKeys` fast path only covers
  ascending ranges unless the browser has the newer `getAllRecords` API, so a
  reversed `primaryKeys()` walks a cursor on Firefox and Safari. Read forwards
  and reverse the array in memory.
  See also `docs/notes/conversations.md`, whose account-wide index caching
  builds directly on these measurements.
- **`useLiveQuery` observes the whole result set.** `useMailboxEmails` used it,
  so touching one row — which is exactly what `markRead()` does when you open an
  unread message — invalidated the query and re-read, re-decrypted and re-sorted
  the entire mailbox. Measured with a 20k mailbox: the avoidable list work per
  single-row change was ~400ms; the hook now costs ~17ms on top of the bare
  `put`. The list is loaded once and kept current from Dexie's *table hooks*
  instead. Two things there that had to be checked against the runtime rather
  than assumed (see `features/mail/hooks.test.tsx`):
  1. `put()` on an existing key fires **`updating`**, not `creating`, and hands
     over `(modifications, primKey, oldObj)` — the *old* row, not the new one.
  2. `modifications` is a **deep diff keyed by dotted paths**
     (`"payload.plain.keywords.$seen"`), so `{...oldObj, ...mods}` silently
     produces a property literally called that instead of updating the payload.
     Use `Dexie.setByKeyPath()` on a `structuredClone` of the old row.
  `bulkPut`/`bulkDelete` do fire these hooks once per row, so no write path
  needed changing.
  Two more things the hooks impose: they run **inside the write transaction**,
  where a fresh read cannot see the row being written, so a re-read has to be
  deferred to a macrotask — which also coalesces a sync page of 200 rows into
  one re-read instead of two hundred.
- **Listing a mailbox never loads the whole mailbox.** Ordering comes from
  index-only reads that never touch a payload: `primaryKeys()` over
  `[accountId+receivedAt]` (already in date order) intersected with the
  `*mailboxIds` index, then `bulkGet` for just the visible window (`PAGE = 100`,
  grown by Virtuoso's `endReached`). Measured on 20k messages: opening the
  folder went from 1785ms to 225ms, and the next page costs ~50ms.
  This deliberately avoids the denormalised posting-list table that first looked
  necessary — IndexedDB cannot sort a multiEntry `*mailboxIds` query by
  `receivedAt`, but it does not have to: two index scans plus a set
  intersection give the same order for a fraction of the cost, with no schema
  change and no cursor reads. (This is the "windowed loading for very large
  mailboxes" fix referenced in `backlog-done.md`.)
- **The Dexie crypto middleware must be synchronous** (async WebCrypto → IndexedDB
  transaction auto-commit), hence @noble/ciphers. **No cursor reads**
  (`.filter().first()`, `.each()`) on tables carrying a payload — only
  get/bulkGet/toArray/query, or decryption is bypassed (openEnvelope then throws).
- **Table hooks see rows the middleware has not decrypted.** A `creating`/
  `updating` hook runs at a layer where the payload can still be a sealed
  envelope, so calling `openEnvelope` on the row it hands over throws — inside
  the caller's write transaction, which aborts *their* write. That is how
  enabling encryption failed for as long as a mailbox list was mounted:
  `rewriteAccountRows` bulk-puts every row, the list's `applyRow` hook chokes on
  the first sealed one, and the whole migration rolls back with "Envelope is
  encrypted and no store-level decryption is active". It stayed hidden only
  because settings used to be a route: navigating there unmounted the list, so
  no hook was subscribed. `applyRow` now treats an unreadable envelope as
  "unknown here" (drop from cache, schedule the deferred re-read) instead of
  throwing; the re-read after the commit goes through the decrypting read path.
  Reads outside a hook, such as `materialise()`, still throw on purpose — there
  it is a real error.
- **A folder's order comes from a derived index column, not from the account.**
  IndexedDB cannot sort a multiEntry `*mailboxIds` query by `receivedAt`, so
  listing a folder used to mean reading the account's entire date index and
  intersecting it with the folder — flat in the size of the folder, so an empty
  one paid what a 36k one did. `mailboxDates` (`storage/emailRow.ts`) is that
  missing compound index, derived: one entry per mailbox the message is in,
  holding `<mailboxId>\0<inverted receivedAt>`. A prefix range returns one
  folder's ids already newest-first. Measured on 36k messages, same data, same
  page: the 28k inbox 335ms → 111ms, the 5k archive 243ms → 24ms — and it is the
  second number that matters, because the old one barely moved with the folder.
  Two details that are easy to get wrong: the timestamp is **inverted and
  zero-padded**, since only an ascending scan is cheap and inverted ascending
  *is* newest-first; and the separator is **NUL**, or a folder whose id extends
  another one's (`inbox2` inside `inbox`) falls into its range. The index key
  carries no account, so the caller filters on the primary key — mailbox ids are
  only unique per account.
- **A derived column is only as good as the least careful writer.** There were
  four places building an email row by hand; three were converted to a shared
  `toEmailRow` and the fourth — the undo closure in `bulkMove` — was missed,
  which left restored messages indexed under the folder they had been moved
  *to*. Nothing threw. The message simply stopped appearing where it had been
  put back, and only an e2e test caught it. There is one writer now, and a unit
  test pins move-and-undo.
