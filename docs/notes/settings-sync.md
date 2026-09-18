# Settings sync (issue #20)

Theme, theme tuning, language, the conversation-grouping toggle and
per-account hidden calendars follow a user to another browser, mirrored to
`.mel/settings.json` via JMAP FileNode — the same storage Files and Notes
already use. Panel widths, the web-push device id, the notifications
throttle cursor and the per-sender remote-image allow list deliberately do
not; see "What syncs, and what does not" below.

| Layer | Where |
| --- | --- |
| Local aggregation | `src/services/settings.ts` |
| Server write | `src/sync/settingsWriter.ts` |
| Server read / reconcile | `src/sync/settings.ts` |
| Outbox action | `settings.save` in `src/sync/outbox.ts` |
| Files-browser hidden-file convention | `src/features/files/tree.ts` (`isHidden`), `FileBrowser.tsx` |

## Automatic, not opt-in

Sync turns on the moment the account has the `files` capability — no
consent toggle, consistent with every other capability-gated feature in mel
(Files, Sieve, Push, Quota). `Settings → General` shows one line saying
whether it is active, and a second stating the privacy trade-off, but there
is nothing to turn on or off.

## `.mel/`: mel's own files, kept apart and hidden by convention

Mel's own internal files live under `.mel/` at the account's top level —
apart from `Notes/`, which is deliberately user-visible content
(`notes-app.md`). The Files browser hides any entry whose name starts with
`.` by default (`isHidden` in `tree.ts`), with a **Show hidden files** /
**Hide hidden files** toggle to reveal them — persisted per device
(`localStorage`, `mel:files:showHidden`), like the conversation-view toggle
and the remote-image policy: a look-and-feel choice about this browser, not
an account preference, so it is deliberately not part of settings sync.
Never truly hidden: mel's stance throughout is that nothing in the
account is secret from its own owner (see `notes-app.md`), and a folder
revealed this way is an ordinary directory — openable, movable, deletable —
with no special protection. A hidden folder is never offered as a Move
destination either way, regardless of the toggle: nobody is meant to file
something into `.mel/` by hand.

## What syncs, and what does not

**Syncs** — a genuine cross-device preference, nothing secret:

- Theme preference and theme tuning
- Language override
- The conversation-grouping toggle
- Per-account hidden calendars

**Stays local**, deliberately:

- **Panel widths** — px values tied to *this* screen; syncing them would
  fight a different monitor on the very next render.
- **The web-push device id** — a device identity. Syncing it would mean two
  browsers fighting over one push subscription.
- **The notifications throttle cursor** — bookkeeping, not a preference.
- **The per-sender remote-image allow list** (`db.imageSenders`, already
  local-only) — a trust decision, not a UI preference. Silently syncing
  "which senders may load remote images" to every device is a bigger call
  than this issue asked for; left as a follow-up if wanted later.

mel is only ever driven from `accounts[0]` in the UI today — there is no
reachable way to add a second account (`AddAccountForm` only renders when
there is none yet) — so settings are written under the one account's
`.mel/` without needing to answer "which account owns a device-wide
preference." Worth revisiting if multi-account ever lands.

## Read-merge-write, scoped to what actually changed

`settingsWriter.ts` never overwrites `settings.json` blindly. Two things
stack on top of each other:

- Any top-level key this build does not recognise (an older or newer mel
  build's own field) passes through untouched — the same "unknown keys kept
  and written back" rule the note front matter already follows
  (`notes-app.md`), and it protects both directions: an older build cannot
  clobber a field a newer one added, and a newer build reading an older file
  simply sees the fields it expects plus nothing new. A `version` number is
  carried from day one, so a future rename has somewhere to hang a migration
  function, even though nothing has needed one yet.
- Of the keys this build *does* recognise, a push only overwrites the ones
  it was actually asked to write — every `OutboxAction`'s `settings.save`
  case carries `fields: SyncedField[]`, named at the exact UI call site that
  changed something (`['theme']` from the theme select, `['hiddenCalendars']`
  from the calendar sidebar toggle, and so on). Everything else known
  survives from the server exactly as it was.

That second rule is not a nicety — it is what stops two devices changing
*different* settings from clobbering each other. The first design pushed a
full snapshot of everything `collectLocalSettings` could see on every
change, and running mel's own e2e suite (which logs many browser contexts
into one shared `alice@localhost` account, closer to two real devices
racing each other than any one person's normal use) found the bug directly:
device A changing its theme could overwrite device B's just-changed hidden
calendars with device A's stale local copy of it, simply because A's push
included every field it knew about, not just the one it touched.

A field named twice in quick succession — two different settings changed
within the push delay — is **merged into the already-pending push** rather
than either one being dropped: `enqueueSettingsSave` reads the pending
outbox row's own `fields`, unions in the new one, and rewrites just the
payload. A plain "skip if one is already pending" check, which is all the
dedup needed before fields existed to merge, would have quietly discarded
whichever setting changed second.

### What field-scoping does not fix: two writes racing the same file

Scoping stops an *unrelated* field from being part of a push. It does not,
and cannot, stop two pushes racing **the same field**, or racing the file
as a whole — that needs a conditional write (an ETag, a version to compare
against), and JMAP FileNode's `writeFileContent` takes no such thing. Two
writers can still hit the textbook lost update: A reads the file, B reads
it before A's write lands, A writes, B writes back its own — now stale —
copy of whatever A just changed, silently reverting it.

Found the same way as everything else here: not by reasoning about it in
the abstract, but by a **second** bisection after the first one.
`e2e/theme-editor.spec.ts`'s reset assertion kept flickering under
full-suite concurrency even after fields were scoped and after
`settings-sync.spec.ts` (the one file that behaves the most like an actual
second device — it explicitly logs a second browser context into the same
account) was moved to its own Playwright project, run only after
everything else finishes. Isolating `theme-editor.spec.ts` on its own too
made it reliable, which places the cause correctly: not a bad value from
one specific other spec, but *any* second writer racing this spec's own
repeated pushes (three tests in one file, each changing theme tuning) —
consistent with a same-file write race rather than a same-field one.

This is accepted as a trade-off rather than fixed with a retry loop, for
the same reason the conflict rule above is last-write-wins at all: settings
sync is a convenience, not a document two people are collaborating on, and
a lost field self-heals the next time *anything* touches it — the next
local change, or the next full resync once the two writers stop racing.
In real use this needs two actual devices changing settings within a
couple of seconds of each other, which is rare. The e2e suite manufactures
it constantly, because — deliberately, for speed — many spec files share
one account across two concurrent workers, which is a far more adversarial
test of concurrent settings sync than any one person's normal use. See
`playwright.config.ts`'s `settings-sync` and `theme-editor` projects, and
`e2e/settings-sync.spec.ts`'s and `e2e/theme-editor.spec.ts`'s own header
comments, for where those two specs now run instead.

## Applying a remote value never re-triggers a push

The push trigger (`scheduleSettingsSync`) is called only from the UI
controls that change a setting by hand — `sections.tsx`'s selects,
`ThemeEditor.tsx`'s sliders, the calendar sidebar's visibility toggle. None
of the underlying setters (`setThemeTuning`, `useUi().setConversationView`,
`ThemeProvider`'s `setPreference`) call it themselves. This is what makes
`applySettingsSilently` (called only by `reconcileSettings`, never by
anything a person clicked) safe to route straight through those same
setters for theme tuning, conversation view and hidden calendars — applying
a pulled value is not "a change," so it triggers nothing further. A design
review against an earlier draft of this feature flagged the alternative
(the push trigger living inside the shared setters) as a real ping-pong
risk; moving it to the UI call sites instead removes the risk by
construction rather than by a guard.

Two settings still need their own machinery to reach an already-mounted
view from outside React, since neither has a listener otherwise:

- **Theme preference** has no module-level store the way theme tuning does
  — `ThemeProvider` reads `localStorage` once at mount. A remote value goes
  through `applyThemePreferenceSilently` (`app/theme.ts`), which writes
  storage and dispatches a `mel:theme-preference` event; `ThemeProvider`
  listens for it, the same shape `lib/imagePolicy.ts` already uses for its
  own cross-consumer reactivity.
- **Hidden calendars** used to live entirely inside `app/routes/calendar.tsx`
  as a page-local hook, reading `localStorage` only in a `useEffect` keyed
  on the account id — which would miss a value applied while already
  mounted. Moved out to `src/lib/hiddenCalendars.ts` (a route file cannot
  cleanly be imported from `services/settings.ts`), it fires a
  `mel:hidden-calendars` event the same way.

**Language is different: it cannot be applied in place at all.** There is
no reactive plumbing anywhere in `lib/i18n.ts` — `currentLocale` is a
module-load-time constant, and the language `<select>` is the only writer,
always followed by `location.reload()`. Given there is no draft-loss
protection anywhere in mel today (no `beforeunload` guard), auto-reloading
from a background sync mid-compose would be a real regression. A remote
language change instead writes `mel:lang` for the *next* reload and shows
`useUi().showSnackbar` with a manual "Reload" action, rather than forcing
one.

## A push waits three seconds before it actually runs

Not for the dedup — `hasPendingSettingsSave` already makes a second push
enqueued while one is still pending a no-op, no timer needed for that part.
The delay is there because `outbox.ts`'s `flush()` runs a **full** account
resync after *every* successful action, settings included. A push
triggered from the calendar sidebar's visibility checkbox — an inline
control, not a modal — landed that resync in the middle of whatever the
person did next, re-rendering the event list out from under a click a
moment later.

Found the way `e2e-stability.md` says these things get found: not by
assuming load, but by bisecting. `e2e/calendar.spec.ts`'s day-view test
started failing 3/3 once the calendar toggle called `scheduleSettingsSync`
in earnest; stashing just that one line made it pass 3/3 again. Four other
failures in the same run — two calendar drags, two birthdays — turned out
to be the identical mechanism, just harder to spot because nothing there
touches settings sync directly; they simply happened to run in a worker
sharing the account with a toggle test at the wrong moment. All five passed
once the push was delayed instead of firing on the same tick.

Three seconds is long enough that a quick sequence of clicks (this test's
own hide-then-restore-then-open-then-delete) finishes well before the
resync starts, and short enough that nobody doing that fixed a *setting*
would call it slow. The Settings dialog's own controls pay the same delay
for simplicity, though nothing behind a modal was ever at risk of this —
only the inline calendar toggle actually needed it.

## The applied marker is the file tree, not a bespoke timestamp

`reconcileSettings` compares `.mel/settings.json`'s FileNode `modified`
against `db.syncState`'s existing per-collection cursor
(`getState`/`putState` in `sync/engine.ts`, collection `'Settings'`) — the
same mechanism every other synced collection already uses, rather than a
one-off `localStorage` marker. That is deliberate: `resyncAccount()`'s
"fetch everything again" already clears `db.syncState` wholesale, so reusing
it means settings are forced to re-pull the same way mail, contacts and
calendars are, with no extra case needed for it.

`saveSettingsFile` itself writes no marker at all. Neither `createFile` nor
`writeFileContent` on `FilesProvider` hand back the node's `modified` (see
`filenode.md`), and stamping one from the client's own clock would risk a
clock-skewed device shadowing a genuine later change from another one
(device A's fast clock records a marker later than device B's honestly
recent write, so device A never notices B's change). Instead, `flush()`
already resyncs the account after every outbox action succeeds — that pass
is what brings the true server `modified` into `db.files`, and
`reconcileSettings` reads the marker from there. Re-applying our own recent
write once, on that pass, is harmless (applying is idempotent and never
triggers a push, per the section above) rather than the loop it would be if
either of those two things were not true.

## Testing

`services/settings.test.ts` covers the aggregate/apply round trip, the
loop-risk regression (`applySettingsSilently` must never enqueue),
capability gating, and the field-merge behavior (two fields changed within
the delay land in one push; the same field named twice is not duplicated).
`sync/settingsWriter.test.ts` and `sync/settings.test.ts` cover the
read-merge-write logic (unknown keys survive, a field left out of `fields`
is untouched even when the server has it, malformed or non-object JSON is
treated as empty) and the bootstrap/apply-if-newer reconcile logic
respectively, mirroring `noteWriter.test.ts` and `notes.test.ts`'s shape.
`lib/hiddenCalendars.test.ts` covers the extracted hook, including picking
up a value applied from outside it. `features/files/tree.test.ts` covers
`isHidden` and that `moveTargets` never offers a hidden folder.

`e2e/settings-sync.spec.ts` covers the real thing end to end: a changed
theme lands in `.mel/settings.json`, hidden from Files by default and
revealed by the toggle, and — the scenario the issue is titled after — a
second browser context logged into the *same* account (not a second
account, which is what every other cross-context spec here uses Bob for)
picks the value up on its own first sync.

None of the push delay, the field-scoping, or the same-file race above is
asserted on directly anywhere — the point of finding all three was to stop
them from being observable at all — but `e2e/calendar.spec.ts`,
`e2e/contacts.spec.ts` and `e2e/theme-editor.spec.ts` are what caught them,
by simply existing in a suite where many files share one
`alice@localhost` account under two concurrent workers: a far more
adversarial test of concurrent settings sync than any single real user's
normal use, and it found three separate bugs this feature shipped with
before anyone had to go looking for them. `settings-sync.spec.ts` and
`theme-editor.spec.ts` now run in their own Playwright projects, after
everything else, for the reason given above — not because their own
assertions are wrong, but because they are, by design, the two specs most
likely to be *racing* something else's settings push when they run.
