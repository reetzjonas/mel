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
handshake), PWA (update toast, storage.persist).

Invitations and RSVP are done: participant editor in the EventDialog (with contact
autocomplete), Stalwart sends the iMIP invitations, the other side receives the event
plus an invitation view with accept/maybe/decline, and the reply lands as a status on
the organiser's copy. Full round trip covered end to end (`e2e/calendar.spec.ts`,
alice invites bob and bob accepts).

The calendar also has week/day time grids (click-to-create, overlap columns, now line),
multi-calendar colours plus visibility toggles (sidebar, localStorage) and calendar
selection in the EventDialog. Mail follow-ups done: opening attachments (a real bug),
quick actions in the list, folder management (create/rename/delete), draft
autosave, search snippets with `<mark>`, pull-to-refresh. Contacts now sort correctly
by display name.

Settings are a modal over the current screen, not a route: five tabs (General,
Mail, Notifications, Security, Account) with the open one in `?settings=`, so
deep links and the back button keep working and `/settings` redirects in.
See `docs/notes/settings-modal.md`.

Tests: 219 Vitest + 51 Playwright (desktop + mobile; state-mutating specs are
desktop-only, see `testIgnore` in playwright.config.ts). Fastmail mail interop
confirmed by the user.

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
- **Deployment** (nginx-unprivileged, CORS vs same-origin, CI): `docs/notes/deployment.md`

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

Open todos and bugs are tracked as GitHub issues on `reetzjonas/mel`
(`gh issue list`, labelled `enhancement`/`bug` plus an `area: *` label) — that
is the current, authoritative list; do not add new items here.

Still open, not yet in issue form: `CalendarEventNotification/get` is not read
yet (would allow "Bob accepted" as a notification instead of only a dialog
status); local calendar alerts; drag-move/resize of calendar events.

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
limit), all fixed and detailed in `docs/notes/e2e-stability.md`. **If something
flickers again, check account state / shared state / server limits first rather
than assuming system load.**

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
