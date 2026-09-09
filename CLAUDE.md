# mel — context for the next session

Backend-less JMAP webmail as a PWA (mail + contacts + calendar), all data in
IndexedDB, optionally encrypted behind a passphrase. React 19 + TS strict + Vite 8,
Tailwind 4, TanStack Router, Dexie 4 (liveQuery = read model), Zustand for UI state.
UI language: **English by default plus German** via `src/lib/i18n.ts` — never
hardcode strings (user's rule). Approved overall plan:
`/home/joreetz/.claude/plans/ich-will-eine-pwa-hidden-ripple.md`.

Documentation and code comments are English; the German translation lives only in
`src/lib/i18n.ts`.

## Status (all 6 phases done, committed, main)

Working and covered end to end: login (one form, autodiscovery — see below),
delta sync (`Foo/changes` plus fallback), outbox with optimistic writes/undo/backoff,
SSE push plus polling, compose (Tiptap, reply/forward with threading, attachments
staged offline, 10s undo-send, draft autosave), search (Fastmail syntax → JMAP filter,
snippets with `<mark>`), shortcuts (`?` overlay), folder management, quick actions plus
swipe and pull-to-refresh, contacts (RFC 9610, autocomplete while composing), calendar
(month/agenda, DST-safe recurrence via rrule + Temporal), encryption
(Argon2id→KEK→DEK, synchronous AES-GCM via @noble/ciphers as Dexie middleware, AAD
binding, UnlockGate), Web Push without a backend (RFC 9749, full PushVerification
handshake), PWA (update toast, storage.persist).

Invitations and RSVP are done: participant editor in the EventDialog (with contact
autocomplete), Stalwart sends the iMIP invitations, the other side receives the event
plus an invitation view with accept/maybe/decline, and the reply lands as a status on
the organiser's copy. Full round trip covered end to end (`e2e/calendar.spec.ts`,
alice invites bob and bob accepts).

The calendar also has week/day time grids (click-to-create, overlap columns, now line),
multi-calendar colours plus visibility toggles (sidebar, localStorage) and calendar
selection in the EventDialog. Mail follow-ups done: opening attachments (a real bug,
see below), quick actions in the list, folder management (create/rename/delete), draft
autosave, search snippets with `<mark>`, pull-to-refresh. Contacts now sort correctly
by display name.

Tests: 103 Vitest + 42 Playwright (desktop + mobile; state-mutating specs are
desktop-only, see `testIgnore` in playwright.config.ts). Fastmail mail interop
confirmed by the user.

## Login, setup and signing out

One form for every server: **email plus password**, no provider presets any more
(Fastmail and the explicit Stalwart entry are gone). `discoveryCandidates()` guesses
the session URL from the address — `mail.<domain>` first, then the apex, `jmap.`,
`imap.`; for `@localhost` the dev Stalwart on `http://localhost:8080`.
Only **once every candidate has failed** does the form reveal (a) a "look up via DNS"
button (`srvCandidates()`, DoH against Cloudflare, resolving the `_jmap._tcp.<domain>`
SRV record) and (b) a manual server address plus auth method.
**The DoH path never runs on its own** — it discloses the mail domain to a third
party, so it happens on an explicit click only (user's rule).

Why guess rather than use SRV: RFC 8620 provides for the SRV record, but **browsers
have no DNS API** and this app has no backend. Real case `reetz.me`: the SRV record
(`0 1 443 mail.reetz.me`) and CORS are both correct, but the apex has **no A record at
all** — so the naive well-known attempt against `reetz.me` goes nowhere while
`mail.reetz.me` answers immediately.

`signOut()` in `services/accounts.ts` is the only way out (button in the desktop
header and in settings). Two traps, both fixed:

- `removeAccount` did **not** list `addressBooks`/`contacts`/`calendars`/`events`/
  `keyring` among its tables — after "signing out", the previous user's contacts and
  events were still sitting in IndexedDB. A unit test in `accounts.test.ts` now keeps
  the list complete; **a new per-account table must be added there**.
- **A sync in flight writes straight over the purge.** `signOut` therefore, in this
  order: `await stopScheduler()` → delete the account row (nothing can connect
  afresh) → `dropConnection` → await `syncSettled` → only then purge.
  The `await` on `stopScheduler` is the load-bearing part and was missing at first:
  `syncSettled()` only knows about `syncAccount()`, so a tick still sitting in
  `flush()` is invisible to it and goes on to write a complete fresh sync afterwards.
  The scheduler now tracks in-flight ticks (`inflight` map) and `stopScheduler`
  returns a promise for them.
  This is **reproducible**: without the await, `e2e/navigation.spec.ts` finds
  `emails: 4, mailboxes: 6` left behind on the first run. The test asserts per table
  rather than on a total, because "1 row survived" tells you nothing about where.

## Design system (since the UI redesign)

Tokens in `src/index.css`: **OKLCH** colours with an elevation ladder (`canvas →
surface → raised → overlay`), accent is a deep violet, `honey` as the semantic second
tone (flags/unread). Surfaces and spacing carry the layout — **borders are an accent,
not the primary separator**. Panels float (`panel` utility), chrome is `glass`.
Typeface: Inter Variable, self-hosted (no CDN request). Tabular figures globally.
Shared control classes in `src/ui/styles.ts` (`inputClass`, `primaryButtonClass`,
`secondaryButtonClass`, `overlayPanelClass`) — **do not duplicate them per file
again**. Motion via `animate-rise`/`animate-fade` plus a `prefers-reduced-motion`
fallback. Building blocks: `ui/Skeleton.tsx` (instead of loading text),
`ui/EmptyState.tsx` (instead of bare text).

**Scrollbars are set globally** (`scrollbar-width: thin` plus `--mel-scrollbar`,
with `::-webkit-scrollbar` only behind `@supports not` for Safari): without it a
nested scroller (the folder list) gets the browser's chunky default while the page
itself gets the slim overlay bar, so the same list looked different depending on
which element happened to be scrolling. That the bar *widens* while the pointer is in
it is native overlay-scrollbar behaviour and not a fault — see backlog A.

HTML mail deliberately renders on white (senders hardcode dark text);
**plain-text mail** follows the app theme (`textFrameDoc` is handed the colours).

## Deployment

Static image, no backend: the `Dockerfile` builds the bundle and serves it with
**nginx-unprivileged** (uid 101, port 8080), so it drops into a hardened Kubernetes
`securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`) without a shim.
Examples in the repo: `compose.yaml` (port 8081, because 8080 belongs to the dev
Stalwart) and `deploy/k8s/` (Deployment, Service, Ingress).

Two traps, both verified:

- **nginx does not inherit `add_header`**: as soon as a `location` sets a header of
  its own it loses *every* inherited one. The security headers therefore live in
  `docker/nginx-headers.conf` and are `include`d per block. Without that they were
  missing on exactly the path that matters — `/` falls through to `/index.html`
  internally.
- **`sw.js` must not be cached**, or users stay pinned to an old build for as long as
  the entry lives. Only `/assets/*` (hashed) is `immutable`.

Important when deploying: the app talks to the JMAP server **straight from the
browser**, so the origin decides what is needed. Served from a *different* origin —
the usual case, and note that another subdomain already counts — the mail server has
to permit mel's origin via CORS; without it everything fails as an opaque
`TypeError` that nothing on our side can fix or even diagnose. Served from the *same*
origin, CORS never applies at all, but then the proxy in front must route `/jmap`,
`/.well-known/jmap` (and `/dav`) to the mail server first: mel's SPA fallback answers
those paths with `index.html` otherwise (verified against the image), shadowing the
mail server.

CI (`.github/workflows/ci.yml`): `check` (lint, build = typecheck, Vitest) and `e2e`
run in parallel, `publish` depends on both and pushes to ghcr on `push` only. The e2e
job tests **the image**, not the dev server — `playwright.config.ts` reads
`MEL_E2E_BASE_URL` and skips its `webServer` when that is set. Only that way are the
nginx delivery and the service worker registered in production covered at all.

## Dev workflow

```sh
npm run stalwart:seed   # provisions Stalwart 0.16 in Docker from nothing (idempotent)
npm run dev             # localhost:5173
npm test                # Vitest
npm run test:e2e        # Playwright (expects a running, seeded Stalwart)
npm run build           # vite build + tsc (order matters: routeTree.gen)
```

Accounts: `alice@localhost` / `korrekt-pferd-batterie-alice` (bob likewise), admin
password in `docker/stalwart/.admin-pass`. Full reset: see the README.

## Next steps (order confirmed by the user)

1. ~~Calendar week/day grid, multi-calendar colours and toggles~~ **done.**
   Drag-move/resize of events is still missing (today: click-to-create plus dialog
   editing, no drag) — add if wanted.
2. ~~Invitations and RSVP~~ **done** (see above). Still open as a follow-up:
   `CalendarEventNotification/get` is not read yet — the server keeps that list (type
   `updated`/`created`, with `changedBy` and `eventPatch`), which would allow showing
   "Bob accepted" as a notification rather than only as a status in the dialog. Local
   calendar alerts are missing too.
3. **recurrenceOverrides** (editing single instances — for Stalwart's format see
   tests/src/jmap/calendar/event.rs in the Stalwart repo)
4. **vCard import/export**, contact group UI
5. Inline images in compose (`cid:`), threaded view of the mail list
6. **Sieve editor last** (explicitly deferred by the user)

Also open: push test on a real device (user), Fastmail contacts interop (user),
event sync windowing for large calendars.

**Q. ~~Windowed loading for very large mailboxes~~ done.** A 36k-message folder
no longer materialises every header. See the note on mailbox listing below.

### Newly raised (order NOT yet agreed with the user)

Prioritisation is pending, so ask which comes first before starting.
**A is settled; B, C, E, G, F, J, L, M and P are done**, the rest is open. A is not a bug (see there).

**A. ~~Scrollbar width changes~~ settled.** Not a bug: measured together with the
user, `offsetWidth - clientWidth` is **0px** on their machine, so Chrome is
drawing overlay scrollbars — thin and faint at rest, thicker while the pointer
is in the scroll area, returning on its own. My original guesses (a different
scroll container after the route change, `@view-transition`, the reading-pane
iframe) were **all wrong**; do not go there again.

Resolved by softening the thumb (`--mel-scrollbar`) rather than taking the bar
over. Whether it reserves layout width is a platform preference — the same
rules measure 10px in a headed browser here and 0px on a machine set to overlay
— and overriding that costs 10px of sidebar to overrule a choice the user made
for every app they run.

The open question in this note is now **answered by measurement**: with both
present, the standard properties win and `::-webkit-scrollbar` is ignored
(Chrome ≥121). A 24px webkit rule yields 24px on its own but 10px alongside
`scrollbar-width: thin`. So taking the bar over would mean dropping the global
standard-property block for Chrome and keeping it for Firefox only.

**B. ~~Sync status pinned to the bottom of the folder sidebar~~ done.**
`features/mail/SyncStatus.tsx` shows the *actual* live mode (push over SSE / "checking
every 30 s" / connecting / offline), when the last successful sync happened, and how
many outbox entries are still waiting. For that the scheduler keeps a small observable
store (`getSyncStatus` / `subscribeSyncStatus`, consumed via `useSyncExternalStore`) —
snapshots are **replaced, never mutated**, or React misses the change.
Two details that are easy to get wrong when rebuilding: the `nav` was itself the
scroll container, so the footer would have scrolled away with the list — now `nav` is
the column and an inner `div` scrolls; and the Web Push line is driven by
`isSubscribed()` rather than `capabilities.webPush`, otherwise the bar claims
"push notifications on" when no subscription exists at all.
The bar always renders **two lines** (the second possibly empty, fixed height) — it is
pinned to the bottom, so a line appearing would shove the folder list around.
The last sync lives in the `title`, not the text: while pushing it would permanently
read "just now" (user's rule).

**C. ~~Make feature caps and their gates visible~~ done.**
Settings section "Server features" (`features/settings/`): every capability with its
state **and the effect it has in the UI** — the flag list alone explains nothing,
since a hidden feature is invisible by definition. Reachable from the sync bar at the
bottom of the sidebar (where people look when something seems off) and from the
calendar/contacts lock screens. Those used to say "coming in a later phase" — wrong,
the features are finished and the *server* cannot do them; now "This server does not
offer a calendar" plus a link.
`capabilityRows()` is pure and tested; one test keeps the rows and
`AccountCapabilities` in lockstep, so **a new capability must be added there** or it
fails.

**D. Creating calendars** (and presumably renaming/deleting). Present server-side:
`Calendar/set`, and the account capability reports `"mayCreateCalendar": true` (seen
while probing for RSVP). Missing is the provider part (`CalendarProvider` in
`providers/types.ts` only knows `syncCalendars`) plus UI in the calendar sidebar —
analogous to the folder management already in `MailboxSidebar.tsx`.

**E. ~~Bulk editing~~ done.** Selection by checkbox (the avatar becomes one on hover —
costs no column), and while a selection exists a toolbar replaces the search row:
read/unread, flag, move to folder, archive, delete — all with undo. Selection state
lives in `app/store.ts`, **not** in the rows: Virtuoso unmounts rows that scroll out of
view along with their state. Changing folder drops the selection.
Three things that hang off it:

- `services/mailActions.ts` has bulk variants that queue **one** outbox action
  carrying every id (not n of them). `bulkDelete` splits the selection: what is
  already in trash is destroyed for good, the rest moves there — and only the second
  half is undoable.
- `setEmails()` in the JMAP provider **chunks against `maxObjectsInSet`** (500 on
  Stalwart). Without it a whole-folder action blows past a single `Email/set`.
- "Everything in this folder" does **not** use the locally loaded ids but asks
  `queryMailboxIds()` server-side, paging through the mailbox.

**F. ~~Treat spam separately~~ done.** Two parts, both small once G was in
place. Junk **always** blocks remote content, even with the account set to
always load — a message the server already flagged is the last one that should
get a confirmed address; only an explicit per-message release opens it. And a
"Not spam" action appears wherever the others are — reading pane, row hover and
the bulk toolbar — for messages filed as junk, moving them to the inbox with
undo. It is keyed off the message's own mailboxes, not the folder being viewed,
so it stays correct in search results.
Only the move is done: JMAP has no "report as ham" method, and Stalwart's
training hangs off its own Sieve rules, so there is nothing standard to call —
`markNotSpam()` says so rather than implying the server learns from it. (The
dev seed has the spam filter switched off entirely, see `seed.sh`.)

**G. ~~Option "do not load images automatically"~~ done.** Default is to block;
Settings → Privacy switches to always-loading. Releasing is **per message** and
resets when another is opened — the next message is a different sender.
The block lives in the iframe's **Content-Security-Policy** (`img-src data:
cid:` versus `http: https: data: cid:`), not in markup rewriting, because the
CSP also covers what rewriting `<img>` misses: CSS `background-image`,
`srcset`, `<picture>`, `poster`. `data:`/`cid:` stay allowed throughout — those
travel inside the message and tell the sender nothing.
`hasRemoteContent()` decides whether the banner appears and is deliberately
over-eager: a false positive shows a banner that changes nothing, a false
negative loads content without saying so.
Covered from both sides, which is the point: a unit test pins the exact policy
strings, and an e2e proves the browser enforces them (0 requests blocked, 1
after release) — neither half is worth much alone.

**H. Bug: `capabilities.submission` gates nothing.** Noticed while building C: the
flag is computed in `capabilitiesFor()` but never read. On a server without
`urn:ietf:params:jmap:submission` the app therefore offers "new message" and the send
only fails silently in the outbox later. Related: the app switcher shows Mail
**always** (`a.cap === 'mail' || …`), even when `capabilities.mail` is false — then
`conn.mail` is null and the view stays empty. Both are stated honestly in the new
settings section already; the gates themselves are still missing. The user wants this
as its own item.

**I. Capabilities are frozen at login.** `capabilitiesFor()` runs only in
`addAccount()`; `open()` has the fresh session in hand but never writes the stored
state forward. If the server changes something the app **never** notices — this is why
the user suddenly had no calendar and had to sign in again to get it back. `open()`
should update the account row. On top of that (user's wish) a **"reload" button** in
the new settings section `features/settings/ServerCapabilities.tsx`.

**J. ~~"Everything in this folder" truncated silently at 5000 ids~~ done.**
`queryMailboxIds()` now pages through the whole mailbox up to `SELECT_ALL_LIMIT`
(50,000) and reads the server's real total via `calculateTotal`; if the ceiling is
reached the toolbar says so instead of quietly acting on the newest slice.

**K. Resizable panel widths** — folders / mail list / detail view.
The widths are fixed today in `app/routes/mail.tsx` (`lg:w-56`) and
`mail.$mailboxId.tsx` (`lg:w-96`). Store the chosen widths per device in
localStorage, like the calendar visibility toggles.

**L. ~~Missing pointer cursor~~ done.** It was not just those two buttons:
Tailwind 4 dropped the preflight rule that used to give buttons a pointer, so
all 64 of them rendered with the default arrow and felt inert. Set once in
`index.css` for `button`, `[role=button]`, checkbox labels and `summary` rather
than on sixty individual elements, where the sixty-first would be forgotten.
Disabled controls keep the plain cursor — a pointer promises something they
will not do. Pinned in `e2e/navigation.spec.ts`, since losing it again degrades
every control without breaking anything.

**M. ~~GitHub CI~~ done** — see the "Deployment" section above. What remains open is
that no run has ever happened on GitHub itself: everything is verified locally (image
built, container tested, `kubectl --dry-run` clean), but the first real workflow run
is still pending.

**N. Theme editor** for adjusting the UI colours, stored in the browser
(localStorage). The tokens are already defined centrally as OKLCH variables in
`src/index.css` and mapped onto Tailwind through `@theme` — an editor would only have
to override the `--mel-*` variables on `:root`.

**O. Store settings server-side** so the same settings apply across browsers —
**without a backend of our own**. Two candidates, both raised by the user: as a mail
in a dedicated folder, or through JMAP FileNode storage. Note that Stalwart already
reports `urn:ietf:params:jmap:filenode` in the session (seen while probing
capabilities), which would be the more natural route — but it is **not standardised**,
so it belongs behind a capability check with a fallback to purely local settings.

**P. ~~Moving folders~~ done.** "Move to…" in the folder row's "…" menu opens a
target picker; `moveMailbox()` is the same `Mailbox/set` update path as renaming
and is gated on the same right.
`moveTargets()` in `features/mail/mailboxTree.ts` decides what is offered, and
excludes three things: the folder itself, **every descendant** (moving a folder
under its own child would detach that subtree), and **role folders** — Inbox,
Trash and the rest mean something to the server and to every other client, so
user folders are not nested inside them. The same rule removed "new subfolder"
from role folders, which leaves them with no menu at all, since every entry was
already disabled for them.

### e2e stability (the earlier "flakes" had real causes)

The suite was long regarded as sporadically flaky (~40% red full runs) and that was
put down to CPU load. That was **wrong** — there were real causes, all fixed:

0. **Accumulated inbox.** `global-setup` cleaned drafts/sent/folders but left the
   **inbox** untouched. With the RSVP test, real iMIP mail arrives every run
   ("Accepted: …" for alice, "Invitation: …" for bob) — after a few runs those sat
   above the seeded mail and the virtualised list stopped rendering
   `Willkommen bei mel`/`HTML-Test` at all. Symptom: several mail specs cannot find
   "their" message. Bob had accumulated **70** stale mails this way. `global-setup`
   now trims the inbox back to the seeded subjects (`SEEDED_INBOX`).

0a. **Stalwart provisions no Archive mailbox.** Its defaults are Inbox, Drafts,
   Sent Items, Deleted Items and Junk Mail, so the *first* archive action has to
   create one — which only shows up on a freshly seeded server, i.e. in CI and
   never locally once a run has created it. Two consequences: the assertion on
   the "Archived" snackbar gets a longer timeout, and `ensureArchiveId()` uses
   the id `Mailbox/set` returns instead of syncing the whole account to look it
   up (measured at 143ms vs 166ms locally — a real simplification, but *not*
   what made CI fail; do not credit it with that).
   The actual cause was the third instance of the same pattern as 0b:
   `archiveEmail` returns null when no Archive mailbox could be created and
   every call site did `if (undo) showSnackbar(...)`, so a failure was
   **indistinguishable from success** — nothing happened at all. All three call
   sites now report it.

0b. **Buttons that silently do nothing.** "New event" began with
   `if (!defaultCalendarId) return` — before the calendars had synced, clicking did
   nothing and the test ran into its timeout. Under load (2 workers) it hit that
   window roughly every third run. The button is `disabled` now, which makes
   Playwright wait on its own. **Rule: a handler that returns early belongs behind a
   visible `disabled`** — otherwise it is a dead button for people and tests alike.

1. **Accumulated test data.** Every run left drafts/sent mail/contacts/events behind
   (the draft-autosave test *must* leave a draft; failing tests skip their cleanup).
   After ~50 mails the initial sync got slow enough that 15s waits expired. →
   `e2e/global-setup.ts` resets both accounts to the seeded state before every run.
   Per-test cleanup alone is not enough in principle.
2. **A real app bug** (see `mail.tsx`): the inbox auto-redirect did not check whether
   you were still on `/mail`. Clicking Calendar/Contacts during the first sync yanked
   you back. Regression: `e2e/navigation.spec.ts`.
3. **Stalwart rate limit**: 25 mails per hour per sender/recipient pair. The send test
   goes alice→bob every run; after ~25 runs it produced `452 4.4.5 Rate limit
   exceeded` — visible only as "the mail never arrives". Switched off for dev in
   `seed.sh` (`x:MtaInboundThrottle`, `enable:false`).

Also: `workers: 2`, and `mobile` sits behind `desktop` via `dependencies` — every spec
drives the same account, and parallel files were archiving each other's mail. Green
full runs ever since. **If something flickers again, check these classes first
(account state, shared state, server limits) rather than assuming system load.**

## Hard-won gotchas (do not rediscover)

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
- **The mailbox list trusts the header, not the index that ordered it.**
  `publish()` skips any row whose own header no longer lists the mailbox. Without
  that, a message removed from the cache on a move could be pulled straight back
  by the next `materialise()` if the ordering index still reported membership —
  the row then reappears carrying its *updated* header, so everything about it
  changes except that it is still listed. Reported from the field as "the mail
  stays in junk but the not-spam button disappears"; not reproduced locally, so
  the fix is a consistency guarantee rather than a diagnosed root cause.
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
  change and no cursor reads.
- **The Dexie crypto middleware must be synchronous** (async WebCrypto → IndexedDB
  transaction auto-commit), hence @noble/ciphers. **No cursor reads**
  (`.filter().first()`, `.each()`) on tables carrying a payload — only
  get/bulkGet/toArray/query, or decryption is bypassed (openEnvelope then throws).
- Stalwart calendar: `recurrenceRule` is **singular** (not `recurrenceRules`);
  ContactCards are **flat** JSContact objects (no `card` wrapper).
- **Scheduling/iTIP has three traps, all silent** (worked out the hard way, see
  `providers/jmap/calendars.ts`):
  1. `CalendarEvent/set` needs the argument **`sendSchedulingMessages: true`**.
     Without it the event including its participants is stored but **no invitation is
     sent** — no error, no warning.
  2. Stalwart names participants by **`calendarAddress: "mailto:…"`** (the newer
     JSCalendar draft), *not* `sendTo`/`email`/`replyTo` as in RFC 8984. Send the
     RFC 8984 shape and it lands as an opaque `JSPROP` fallback in the iCalendar,
     **no ATTENDEE lines** are produced, `/get` does not return `participants` at all
     — and again: no error.
  3. `roles: {owner: true}` alone is not enough: **without
     `organizerCalendarAddress` Stalwart writes no ORGANIZER** and sends nothing. The
     price is that the server mirrors the organiser back as a second, roleless
     participant entry — `toParticipants` folds that back together by address and
     keeps the entry *with* roles (only its key works for RSVP patches).
  Roles are `owner`/`chair`/`required`/`optional`. RSVP is a patch on
  `participants/<id>/participationStatus` (a patch trying to create a *whole* new
  participant fails with `invalidPatch`).
  Debugging trick: read the raw iCalendar over CalDAV (`PROPFIND`/`GET` on
  `/dav/cal/<user>/default/…`) — that shows immediately whether ATTENDEE/ORGANIZER
  were really written or only `JSPROP` lines.
- Server settings for it: `x:CalendarScheduling` (`enable`, `autoAddInvitations`,
  HTTP RSVP) — `enable` is already on in the dev Stalwart, nothing to do.
- Calendar only works against Stalwart (Fastmail has no standard JMAP calendar);
  capability gating is in place in the AppShell.
- e2e: desktop and mobile share one server account → state-mutating specs are desktop
  only (`testIgnore`); tests must clean up their server-side artifacts or use random
  names/days (calendar cells cap at 3 chips).
- **`new Date()` as an anchor/grid date carries the current time along** — used
  directly as a sync window boundary (`grid[0]`/`grid[last]`) it shifts the window
  after midday to "now until tomorrow-now" instead of midnight to midnight, dropping
  earlier events. Always normalise to midnight before using date objects as window
  boundaries (see `byDay` in `calendar.tsx`).
- **`e2e/contacts.spec.ts` never used to clean up** → one more "Erika Testling…"
  contact every run, until `suggestRecipients` (capped at 8 hits) eventually pushed
  the newest one out and the test flickered. Fixed (it deletes itself now) — if
  contact autocomplete flakes reappear, check `ContactCard/get` on the account first
  for accumulated test corpses.
- **Hover swaps must be height-neutral.** In the folder list the unread counter is
  swapped for the "…" menu button on hover; that button was taller than the badge, so
  every row below jumped by 3px. Both now sit in a fixed 20px box and the row has
  `min-h-[34px]` plus `leading-5`. Regression: `e2e/navigation.spec.ts` measures every
  row with and without hover.
- **The JMAP `preview` often contains CSS.** If the server builds the preview from the
  HTML part, the contents of an inline `<style>` come along and the list shows
  "html, body, * { -webkit-text-size-adjust: none; …". Because the preview is
  truncated the block is usually **unbalanced** — so `lib/preview.ts` also removes the
  trailing partial rule. Only blocks containing `prop: value` are dropped, so
  "Hi {name}" survives.
- Playwright's `getByRole({name: 'X'})` matches **case-insensitively as a substring**
  (not exact) — "Week" also matched leftovers with "…weekly" in the title. For short
  or generic labels (view switchers, action buttons) pass `exact: true`.

## Architecture rules

- `src/domain/` is provider-agnostic and never imports from `providers/`.
- Every row carries its contents in the `plain`/`enc` envelope
  (`storage/envelope.ts`); index columns hold only ids/timestamps/flags (encryption).
- Mutations: optimistic locally plus a `sync/outbox.ts` action (exception: creates
  with a navigation target are server-first with an offline fallback, see contacts.ts).
- Commit messages in English, with the Co-Authored-By trailer. **After finishing a
  feature, ask the user whether everything is right before committing** (explicit
  instruction). They check in a real browser and regularly find what the tests do not.
