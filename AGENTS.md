# mel — context for the next session

Backend-less JMAP webmail as a PWA (mail + contacts + calendar + files + notes), all data in
IndexedDB, optionally encrypted behind a passphrase. React 19 + TS strict + Vite 8,
Tailwind 4, TanStack Router, Dexie 4 (liveQuery = read model), Zustand for UI state.
UI language: **English by default plus German** via `src/lib/i18n.ts` — never
hardcode strings (user's rule). Approved overall plan:
`/home/joreetz/.claude/plans/ich-will-eine-pwa-hidden-ripple.md`.

Documentation and code comments are English; the German translation lives only in
`src/lib/i18n.ts`.

## Status (all 6 phases done, committed, main)

Working and covered end to end: login (one form, autodiscovery — see
`docs/notes/login-discovery.md`),
delta sync (`Foo/changes` plus fallback), outbox with optimistic writes/undo/backoff,
SSE push plus polling, compose (Tiptap, reply/forward with threading, attachments
staged offline, 10s undo-send, draft autosave), search (Fastmail syntax → JMAP filter,
snippets with `<mark>`), shortcuts (`?` overlay), folder management, quick actions plus
swipe and pull-to-refresh, contacts (RFC 9610, autocomplete while composing), calendar
(month/agenda, DST-safe recurrence via rrule + Temporal), encryption
(Argon2id→KEK→DEK, synchronous AES-GCM via @noble/ciphers as Dexie middleware, AAD
binding, UnlockGate), Web Push without a backend (RFC 9749, full PushVerification
handshake, optionally naming sender and subject), PWA (update toast,
storage.persist, mailto handler, share target, icon shortcuts, unread icon
badge, sharing a file out).

Invitations and RSVP are done: participant editor in the EventDialog (with contact
autocomplete), Stalwart sends the iMIP invitations, the other side receives the event
plus an invitation view with accept/maybe/decline, and the reply lands as a status on
the organiser's copy. Full round trip covered end to end (`e2e/calendar.spec.ts`,
alice invites bob and bob accepts).

The calendar also has week/day time grids (click-to-create, overlap columns, now line,
drag to move or resize, in the month grid too, with undo), single occurrences of a
series editable, movable and deletable on their own (RFC 8984 recurrenceOverrides,
with a "this one or all of them?" question — see `docs/notes/recurring-events.md`),
multi-calendar colours plus visibility toggles (sidebar, localStorage) and calendar
selection in the EventDialog. Mail follow-ups done: opening attachments (a real bug),
quick actions in the list, folder management (create/rename/delete), draft
autosave, search snippets with `<mark>`, pull-to-refresh. Contacts now sort correctly
by display name.

Files is the fourth app, where the server offers JMAP FileNode (a draft
extension; the tab is hidden otherwise): folder browsing with breadcrumbs,
upload by button or drop, create folder, rename, move (dialog, drag onto a
folder, or drag onto a breadcrumb), delete (recursive), multi-select (Select toggle,
shift-click for a range) for bulk move/delete/download (a selection or a whole
folder comes down as one zip, via fflate behind a dynamic import), and a
preview for images, text and PDF with a full-window view (a PDF is unreadable
at panel width). Shift-click range selection works in the mail list too. See `docs/notes/filenode.md`.

Notes are the fifth app, and are files too — a folder per note holding a
Markdown `note.md` with front matter, its pictures beside it — so they need no
JMAP capability of their own beyond FileNode (JMAP tasks is a dead draft).
The editor is a live Markdown view (CodeMirror, Obsidian-style: markup hidden
except on the cursor's line, checkboxes and images drawn inline), with a
formatting toolbar and shortcuts so the markup never has to be typed — the
buffer stays the file, so nothing converts anything. Writes are offline-first through
the outbox, unlike the rest of Files. See `docs/notes/notes-app.md`.

Server-side filter rules (Sieve, RFC 9661) are a section in Settings → Mail
where the server offers the capability: a guided rule form for rules mel wrote
itself (round-tripped via a marker comment) plus a script editor for everything
else, with the server's own validation, activation and delete. The reading
pane can start a rule from the open message ("Filter messages like this"). See `docs/notes/sieve.md`.

Settings are a modal over the current screen, not a route: six tabs (General,
Appearance, Mail, Notifications, Security, Account) with the open one in
`?settings=` and an optional section anchor in `?at=`, so deep links and the
back button keep working and `/settings` redirects in. See `docs/notes/settings-modal.md`.

Storage usage (JMAP Quota, RFC 9425) sits in Settings → Account, and the shell
header stays quiet about it until the account is ~90% full, where it shows a
warning that opens that section. The figure is account-wide — one number over
mail, files, calendars, contacts and filter scripts — which is why it is not in
any one app's sidebar. Stalwart only reports a quota once one is configured, so
`seed.sh` sets one; see the quota entry in `docs/notes/gotchas-jmap-mail.md`.

Tests: 1178 Vitest + 118 Playwright (desktop + mobile; state-mutating specs are
desktop-only, see `testIgnore` in playwright.config.ts). Fastmail mail interop
confirmed by the user. `npx tsc -b` is the typecheck that runs — `tsc -p
tsconfig.json` is a no-op, since the root config is a solution file with
references and no files of its own.

Coverage runs with `npm run test:coverage` and is enforced per area in
`vitest.config.ts` — `domain`/`lib`/`storage` near total, `providers` ~93%,
`sync` ~85%, `services` ~92%, plus a low global floor. The global number
(~55%) counts every component as well, and those are covered by Playwright,
which contributes nothing to this metric: read it as "what the unit tests
reach", never as how well the app is tested. Raise the thresholds when the
work raises the number rather than leaving slack to grow.

## Feature deep-dives (read the file when you touch that area)

These used to be inline here; moved out because each is only relevant when
working on that specific feature, not on every session:

- **Conversations / threading** (`threadId` grouping, folding, NEW-marking,
  archive/delete scope): `docs/notes/conversations.md`
- **Drafts reopened in the editor** (autosave, Save button, `followDraft`):
  `docs/notes/drafts.md`
- **Outbox queue visible/manageable** (Settings → Queued changes):
  `docs/notes/outbox-queue.md`
- **Login, autodiscovery, sign-out** (`discoveryCandidates`, DoH SRV lookup,
  purge-vs-sync-race): `docs/notes/login-discovery.md`
- **Design system** (OKLCH tokens, scrollbar behaviour, hover-height rule):
  `docs/notes/design-system.md`
- **Drag and drop** (mail onto folders, folders into folders, events on the
  week/day grid; pointer-only, menu and dialog stay the accessible path):
  `docs/notes/drag-and-drop.md`
- **Recurring events** (editing one occurrence, the patch format, why the
  scope question comes after the drag): `docs/notes/recurring-events.md`
- **Theme editor** (guided OKLCH tuning, why lightness is never exposed, the
  gamut and contrast maths): `docs/notes/theme-editor.md`
- **Resizable panel widths** (two boundaries, lg and up only; why the handles
  cost no layout, and the pointercancel that collapsed a panel):
  `docs/notes/panel-widths.md`
- **Filter rules / JMAP Sieve** (script editor in Settings → Mail, server-side
  validation, the RFC-vs-Stalwart error names): `docs/notes/sieve.md`
- **Files / JMAP FileNode** (the fourth app: browse, upload, preview, zip
  download; draft extension, capability-gated, the blob-id, null-index,
  destroy-ordering and nodeType-from-blobId traps): `docs/notes/filenode.md`
- **Notes** (the fifth app: why a note is a Markdown file and not a JSON blob,
  why images are separate files, why the id lives in the file, and how the live
  Markdown editor is built): `docs/notes/notes-app.md`
- **Push notifications** (why naming the sender costs a request, why it is
  unencrypted-only, how the service worker reads IndexedDB without Dexie):
  `docs/notes/push-notifications.md`
- **PWA integration** (the `/compose` entry point behind mailto and share, the
  RFC 6068 plus-address trap, the icon badge, why there are no file handlers):
  `docs/notes/pwa-integration.md`
- **Deployment** (nginx-unprivileged, CORS vs same-origin, CI): `docs/notes/deployment.md`
- **PGP / S-MIME** (issue #63): public keys on contact cards are done; the note
  is mostly a design pass for the mail half — why verification needs the raw
  message, why sending needs a second path, and why the private key is protected
  by its own OpenPGP passphrase rather than by mel's at-rest encryption:
  `docs/notes/pgp-smime.md`
- **Settings sync** (issue #20): theme, language and a few other preferences
  mirrored to `.mel/settings.json` via JMAP FileNode — what syncs and what
  deliberately stays local, the read-merge-write schema-evolution rule, why
  applying a remote value never re-triggers a push, and the dotfile-hidden
  `.mel/` convention this introduced in the Files browser:
  `docs/notes/settings-sync.md`

## Dev workflow

```sh
npm run stalwart:seed   # provisions Stalwart 0.16 in Docker from nothing (idempotent)
npm run dev             # localhost:5173
npm test                # Vitest
npm run test:e2e        # Playwright (expects a running, seeded Stalwart)
npm run build           # vite build + tsc (order matters: routeTree.gen)
```

**Never `npm i` on the host** unless it is running the Node in `.nvmrc` (22).
npm 11 writes a lockfile that omits optional entries npm 10 insists on, so the
install succeeds here and `npm ci` fails in CI with "Missing:
@floating-ui/dom@… from lock file" — twice now, once for the coverage reporter
and once for fflate and CodeMirror. Add a dependency the way CI would read it:

```sh
docker run --rm -v "$PWD":/app -w /app node:22-alpine \
  npm install --package-lock-only <package>
```

and check it the same way, in a copy so the host's node_modules keeps its own
platform binaries:

```sh
docker run --rm -v "$PWD":/src:ro -w /tmp/check node:22-alpine \
  sh -c 'mkdir -p /tmp/check && cp /src/package*.json . && npm ci --ignore-scripts'
```

Accounts: `alice@localhost` / `korrekt-pferd-batterie-alice` (bob likewise), admin
password in `docker/stalwart/.admin-pass`. Full reset: see the README.

## Next steps (order confirmed by the user)

Open todos and bugs are tracked as GitHub issues on `reetzjonas/mel`
(`gh issue list`, labelled `enhancement`/`bug` plus an `area: *` label) — that
is the current, authoritative list; do not add new items here.

Everything known to be open is in that list — including the calendar follow-ups
that used to be named here (`CalendarEventNotification/get`, local alerts,
drag-move/resize), which are issues #3, #4 and #28.

Everything that already shipped from the old backlog (sync status bar, feature
capability visibility, bulk editing, spam handling, image blocking, select-all
paging, pointer cursor, moving folders, the request-storm investigation,
mobile folder drawer, message metadata view, compose rewrite) is kept as
detailed "why" notes in `docs/notes/backlog-done.md` — not a todo list, kept
for the reasoning behind each.

### e2e stability

The suite was long regarded as sporadically flaky (~40% red full runs) and that
was put down to CPU load. That was **wrong** — there were real causes (accumulated
test data across runs, a real app bug in the inbox auto-redirect, a Stalwart rate
limit, and a per-account cap of 4 concurrent requests), all fixed and detailed in
`docs/notes/e2e-stability.md`. **If something flickers again, check account state
/ shared state / server limits first rather than assuming system load** — and
when a change is suspected, bisect it (two full runs with it, two with it
stashed) instead of guessing; that is what named the concurrency cap.

## Hard-won gotchas (do not rediscover)

Split by topic, since each is only relevant when working in that area:

- **JMAP protocol, sync, mail** (Stalwart admin API shape, CORS/DNS error
  handling, paging cursor bugs, delta sync gaps, outbox `inflight` recovery,
  server-limit handling, URL template encoding): `docs/notes/gotchas-jmap-mail.md`
- **Dexie / IndexedDB performance** (`keys()` vs `primaryKeys()`, `useLiveQuery`
  whole-result-set invalidation, windowed mailbox listing, sync crypto
  middleware): `docs/notes/gotchas-dexie-performance.md`
- **Calendar / iTIP scheduling** (Stalwart's JSCalendar quirks, ORGANIZER/ATTENDEE
  traps, midnight-anchor dates): `docs/notes/gotchas-calendar.md`
- **Writing Playwright tests** (accessible-name matching, cleanup, substring
  matching): `docs/notes/gotchas-testing.md`

## Architecture rules

- `src/domain/` is provider-agnostic and never imports from `providers/`.
- Every row carries its contents in the `plain`/`enc` envelope
  (`storage/envelope.ts`); index columns hold only ids/timestamps/flags (encryption).
- Mutations: optimistic locally plus a `sync/outbox.ts` action (exception: creates
  with a navigation target are server-first with an offline fallback, see contacts.ts).
- Commit messages in English, with the Co-Authored-By trailer. **After finishing a
  feature, ask the user whether everything is right before committing** (explicit
  instruction). They check in a real browser and regularly find what the tests do not.
- Commit subjects follow **Conventional Commits** (`feat:`, `fix:`, `chore:`,
  `refactor:`, `docs:`, `test:`, `ci:`, `perf:`) as of the release-please setup
  (issue #55) — release-please's release PR (bump + `CHANGELOG.md`) is generated
  from these, and only `feat`/`fix`/`perf` show up in the changelog. A breaking
  change is a `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer.
