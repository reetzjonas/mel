# Hard-won gotchas: JMAP protocol, sync, mail (do not rediscover)

- **Delta sync never brings a field the app did not ask for last time.** A
  cursor carries "what changed on the server", so teaching a mapper a new
  property reaches rows already on disk exactly never — the server has no
  reason to call those objects changed. Adding `birthday` to contacts this way
  looked like a calendar bug: the phone, signed in after the release, showed
  birthdays while the desktop, signed in before it, showed none, from the same
  account. Signing out and back in was the only cure anyone found. `sync/engine.ts`
  now keeps a `MODEL_VERSION` per collection and stores it beside the cursor
  (`SyncStateRow.modelVersion`); a cursor whose version is behind is not
  resumed, so the next sync refetches that collection once. **Bump the number
  when a mapper starts keeping a field it used to drop.**
- **An update is a patch, so an omitted property is one the server keeps.**
  `fromContact` used to emit `undefined` for a field the contact no longer had,
  which `JSON.stringify` drops — so deleting a contact's last email address
  saved without complaint, reported success, and left the address exactly where
  it was until the next sync put it back on screen. `null` is what JSContact
  means by "no value" and the only thing that clears; every managed property is
  now spelled out as null when empty, with a test listing them.
- **A contact's picture is `media`, not `photos`, and cannot be a blob.**
  RFC 9553 keeps photos, logos and sounds in one `media` map, each entry a
  `Media` with `kind: "photo"`; there is no `photos` property, and sending one
  is refused as `invalidProperties`. A `blobId` there is refused too —
  "blobIds in media is not supported" — so the picture travels inline as a
  `data:` URI, inside the card, through every sync. That is why mel scales a
  picked image down before storing it (`features/contacts/photo.ts`), and why
  writing a photo replaces the whole `media` map, dropping a logo or sound a
  card happened to carry.
- **Stalwart drops a JSContact `OnlineService` that lacks `uri` or `@type`, and
  says nothing.** The card is created, the response carries no `notCreated`, and
  the property simply is not there on the next fetch. `uri` takes any string, so
  a handle with no link travels as its own uri and is read back into `user`.
  Worth assuming the same of other JSContact sub-objects: silence here is not
  acceptance.

- **A quota exists only once somebody sets one.** Stalwart answers `Quota/get`
  with a record only while `account.disk_quota() > 0`; an account created
  without a limit is unlimited and the list comes back empty — which is why
  `docker/stalwart/seed.sh` sets `quotas.maxDiskQuota` on alice and bob (every
  run, not only on creation, so older dev databases pick it up). Confusingly
  `Quota/query` still reports `total: 1` for an account with no quota while
  returning no ids at all. What it reports is one object, `resourceType:
  "octets"` and `scope: "account"`, counting Email, SieveScript, FileNode,
  CalendarEvent and ContactCard together — so the figure is account-wide, never
  per app. `warnLimit` and `softLimit` are in the response but Stalwart never
  assigns them (they are always null), which is why the "nearly full" threshold
  in `features/settings/quota.ts` is ours rather than the server's. `count`
  quotas and the domain/global scopes exist in RFC 9425 and are deliberately
  ignored; see issue #58.

- **Stalwart ≥0.16 has NO REST admin API.** Everything goes through JMAP management
  (`urn:stalwart:jmap`, objects `x:Bootstrap`, `x:Http`, `x:Account`, `x:Jmap`,
  `x:Task`…). Schema: `GET /api/schema` (gzip). Details in `docker/stalwart/seed.sh`
  and in the memory file `stalwart-jmap-management-api.md`. Key points: settings
  written in bootstrap mode do not survive (restart, then configure as the permanent
  admin, restart again); credential maps need numeric keys; zxcvbn password strength
  is enforced; EHLO without a dot → 550; `STALWART_PUBLIC_URL` is required;
  `usePermissiveCors` is not enough (static `responseHeaders` are needed); FTS needs
  `searchStore` plus possibly a `reindex` task; VAPID is `webPushKey`
  (`{"@type":"Text","secret":"<PKCS#8 PEM>"}`).
- **A browser cannot tell CORS from a DNS failure, a refused connection or TLS** —
  `fetch()` throws the same opaque `TypeError: Failed to fetch` for all of them. So
  never claim "CORS error"; `lib/netError.ts` only classifies coarsely
  (`unreachable`/`auth`/`other`) and the copy names the candidates plus a pointer to
  the browser console, where the real reason is printed.
  Two places where the error used to vanish completely:
  1. `startSse()` fetched the session **outside** its `try` — if that failed on CORS
     the rejection went nowhere, there was no polling fallback, and the status bar sat
     on "connecting" forever.
  2. `tick()` swallowed every error (`catch {}`), so a server refusing us looked
     exactly like an empty mailbox. `SyncStatus.error` carries it now.
  3. A **permanently failed outbox action** was marked `failed` and then filtered
     *out* of the sync bar's count, so it vanished without a trace. The local
     optimistic change had already happened, so the next sync quietly undid what
     the user asked for — "I clicked not-spam and the mail is still in junk".
     Failed actions now show in the bar in red, and the reason goes to the
     console (`[mel] outbox action "…" failed permanently`). Regression in
     `e2e/navigation.spec.ts`, which forces a 400 on `Email/set`.
     A count plus a console line is still only a report, so the queue is now
     **manageable** — see `docs/notes/outbox-queue.md`.
  At login, `NoServerFound.lastError` now distinguishes "nothing found" from "not
  reachable" — otherwise "no mail server found" sends the user hunting for a typo when
  their server is up and merely missing CORS headers.
- **e2e: `page.route('**/jmap/**')` also blocks the app's own modules**, which Vite
  serves in dev under `src/providers/jmap/…` → blank page, test measures nothing. For
  connection failures, route the server origin (`http://localhost:8080/**`).
- **Paging: always advance the cursor by the page size actually requested.**
  `listAllEmailHeaders` had `limit: QUERY_PAGE` (200) while the cursor moved by
  `BULK_QUERY_PAGE` (1000) → **80% of all mail was never fetched**, and because
  `fullEmailSync` deletes local rows the server supposedly no longer has, they were
  **actively deleted** as well. Symptom: a folder looks empty while the server reports
  mail. Regression in `providers/jmap/mail.test.ts` (pages must be contiguous:
  `[0, 200, 400, 600]`). Caused by a global search-and-replace — look closely at any
  `position +=`.
- **A delta sync cannot repair gaps.** The server never "changed" the missing rows, so
  the cursor skips them forever. That is what `resyncAccount()` is for (Settings →
  Account → "fetch everything again"): it drops the sync cursors, forces a full sync,
  fills the gaps and prunes.
- **A folder row's accessible name grows an unread counter.** So
  `getByRole('link', {name, exact: true})` stops matching the moment the folder
  holds unread mail — which on a freshly seeded server it does, and locally it
  usually does not, so this only shows up in CI. Use an anchored regex
  (`^Name( \\d+)?$`) rather than dropping exactness, or a subfolder called
  `Name-sub` matches too.
- **`global-setup` now fails if seeded mail is missing** (`EXPECTED_INBOX`),
  naming the subject. Without that, a destroyed seed mail surfaces as some
  unrelated spec failing much later — it cost three separate debugging sessions
  before the check existed. `seed.sh` will not top up a partially populated
  mailbox: its guard is `TOTAL < 4`, so restoring means re-sending the specific
  message over SMTP or doing the full reset from the README.
- **Careful with `onDestroyRemoveEmails: true` while debugging.** Deleting the
  Archive mailbox to reproduce a fresh-server state destroyed seeded mail twice,
  because messages archived by an earlier test lived *only* there — and the seed
  guard (`< 4 mails`) will not put them back. Move the contents out first, or
  destroy with the flag off. Restoring means re-sending the specific message over
  SMTP; see `docker/stalwart/seed.sh` for the exact payloads.
- **Deleting a folder has two separate refusals** (verified against the server):
  `mailboxHasChild` ("Mailbox has at least one children.") → children must go first;
  `mailboxHasEmail` ("Mailbox is not empty.") → needs `onDestroyRemoveEmails: true`.
  The latter does **not** delete mail wholesale: each message merely loses this
  mailbox, and it only ceases to exist if it was filed nowhere else. The confirmation
  dialog says exactly that.
  **The folder list for that walk comes from the server** (`serverMailboxes()`), not
  from Dexie: this case arises precisely when the local mirror is incomplete —
  otherwise the app finds no children and fails in circles. Deepest child first.
- **The folder sidebar used to be a flat, globally sorted list** with a blanket 2rem
  indent for anything with a parent. Subfolders therefore sat alphabetically among
  unrelated folders and a parent looked childless.
  `features/mail/mailboxTree.ts` now orders it as a real tree (indent per level);
  folders whose parent is unknown are shown as roots rather than swallowed.
- **An outbox action stranded in `inflight` is invisible forever.** The status is
  set just before `execute()`; close or reload the tab at that moment and nothing
  resets it, because `flush()` only ever selects `pending`. The row then never
  runs, never fails and reports nothing, while the optimistic local change is
  reverted by the next sync — a move that looks like it worked and then undoes
  itself. `recoverStranded()` runs at the start of every flush, inside the lock
  (so anything inflight there belongs to a dead run) and requeues it. Only the
  **idempotent** kinds are replayed — `REPLAYABLE`; creates and sends are failed
  loudly instead, because replaying those risks a second message.
  Found from a user's IndexedDB dump: `{kind: 'email.update', status: 'inflight',
  attempts: 0}` sitting there while the mail kept reappearing in junk.
- **A missing server limit silently dropped every mutation.** `coreLimits()` was
  `core ?? defaults`, all-or-nothing: a server that sends the core capability but
  omits one number left it `undefined`. `chunkIds(ids, undefined)` then returned
  **one empty chunk** — so `setEmails` issued an `Email/set` carrying neither
  `update` nor `destroy`, got back `{updated: {}, failed: {}}`, reported success,
  and the outbox deleted the action. Every move, flag and mark-read was applied
  locally, never sent, and reverted by the next sync — **with no error anywhere**.
  It only reproduces against such a server; the dev Stalwart sends 500 and works.
  Fixed in three layers, each independently sufficient: limits merge per field;
  `chunkIds` returns one full chunk for a nonsense size (an oversized request is
  rejected visibly, dropping ids is not); and `setEmails` marks any id the server
  acknowledged in neither direction as a transient failure, so the outbox retries
  and the sync bar shows it instead of losing the change.
- **`new URL()` destroys `{placeholders}`** in JMAP URL templates (percent-encoding) —
  fixed in `client/session.ts` `abs()`; do not remove.
- **JMAP `properties: []` means "id only"** — send `undefined` for all properties
  (this bug had wiped mailbox names locally).
- **The mailbox list trusts the header, not the index that ordered it.**
  `publish()` skips any row whose own header no longer lists the mailbox. Without
  that, a message removed from the cache on a move could be pulled straight back
  by the next `materialise()` if the ordering index still reported membership —
  the row then reappears carrying its *updated* header, so everything about it
  changes except that it is still listed. Reported from the field as "the mail
  stays in junk but the not-spam button disappears"; not reproduced locally, so
  the fix is a consistency guarantee rather than a diagnosed root cause.
- **The JMAP `preview` often contains CSS.** If the server builds the preview from the
  HTML part, the contents of an inline `<style>` come along and the list shows
  "html, body, * { -webkit-text-size-adjust: none; …". Because the preview is
  truncated the block is usually **unbalanced** — so `lib/preview.ts` also removes the
  trailing partial rule. Only blocks containing `prop: value` are dropped, so
  "Hi {name}" survives.
