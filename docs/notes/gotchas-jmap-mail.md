# Hard-won gotchas: JMAP protocol, sync, mail (do not rediscover)

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
