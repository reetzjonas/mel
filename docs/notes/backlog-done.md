# Shipped backlog items — why, not just that

Open todos and bugs are tracked as GitHub issues on `reetzjonas/mel`
(`gh issue list`, labelled `enhancement`/`bug` plus an `area: *` label) — that
is the current, authoritative list for what's still open; nothing in this file
is a todo. This file exists because each entry below documents *why* something
works the way it does, which a closed GitHub issue doesn't capture.

Letters skip around (some entries, e.g. the scrollbar note, moved into
`design-system.md` instead) — that's fine, they're just historical labels.

Still open, not yet in GitHub-issue form: drag-move/resize of calendar events
(click-to-create plus dialog editing works, no drag yet); reading
`CalendarEventNotification/get` to show "Bob accepted" as a notification
rather than only a status in the dialog; local calendar alerts.

**B. Sync status pinned to the bottom of the folder sidebar.**
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

**C. Make feature caps and their gates visible.**
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

Two flags were listed here for a while with a row that said, honestly, that nothing
was gated on them — `mail` (the tab was shown regardless) and `submission` (compose
stayed open and the send died later in the outbox). Both are real gates now (issue
#15): no Mail tab and a notice on `/mail` without `mail`, and without `submission`
nothing offers to write a message — sidebar button, mobile FAB, reply/forward, the
`c`/`r`/`a`/`f` keys, the contact's "send mail", and Send itself in a reopened draft.
Picking a draft back up stays, since that is an edit of a message that already
exists and does not depend on delivery. **A row in `capabilityRows()` is a promise
about behaviour**: when a gate changes, its text changes in the same commit.

The capability list itself used to be frozen at `addAccount()`, so a flag the admin
switched on was invisible until sign-out and back in (issue #16). `connectionFor()`
now writes back what each fresh `open()` reports, and Settings has a "Check again"
that drops the cached connection to force one. Worth knowing when writing tests:
falsifying capabilities in IndexedDB no longer survives a reload — `e2e/capabilities.spec.ts`
intercepts the *session response* instead, at both `.well-known/jmap` and the
`/jmap/session` it redirects to (the redirected URL is the one that gets stored).

**E. Bulk editing.** Selection by checkbox (the avatar becomes one on hover —
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

**F. Treat spam separately.** Two parts, both small once the image-blocking item
was in place. Junk **always** blocks remote content, even with the account set to
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

**G. Option "do not load images automatically".** Default is to block;
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

**J. "Everything in this folder" truncated silently at 5000 ids.**
`queryMailboxIds()` now pages through the whole mailbox up to `SELECT_ALL_LIMIT`
(50,000) and reads the server's real total via `calculateTotal`; if the ceiling is
reached the toolbar says so instead of quietly acting on the newest slice.

**L. Missing pointer cursor.** It was not just those two buttons:
Tailwind 4 dropped the preflight rule that used to give buttons a pointer, so
all 64 of them rendered with the default arrow and felt inert. Set once in
`index.css` for `button`, `[role=button]`, checkbox labels and `summary` rather
than on sixty individual elements, where the sixty-first would be forgotten.
Disabled controls keep the plain cursor — a pointer promises something they
will not do. Pinned in `e2e/navigation.spec.ts`, since losing it again degrades
every control without breaking anything.

**P. Moving folders.** "Move to…" in the folder row's "…" menu opens a
target picker; `moveMailbox()` is the same `Mailbox/set` update path as renaming
and is gated on the same right.
`moveTargets()` in `features/mail/mailboxTree.ts` decides what is offered, and
excludes three things: the folder itself, **every descendant** (moving a folder
under its own child would detach that subtree), and **role folders** — Inbox,
Trash and the rest mean something to the server and to every other client, so
user folders are not nested inside them. The same rule removed "new subfolder"
from role folders, which leaves them with no menu at all, since every entry was
already disabled for them.

**Q. Request storm on first load in a fresh browser — partially diagnosed and
improved.** Opening mel in a brand-new browser (empty IndexedDB/cache) fired ~361
requests to `jmap/` — all `Email/query` calls per the Network tab payload —
totalling 33.3 MB over about 8 minutes before `DOMContentLoaded`.

Not reproduced against a real large mailbox (no fixture that size exists locally
or in CI, and this was only ever observed via a screenshot of DevTools' Network
panel from the user's own Fastmail account) — so this is a code-audit diagnosis
plus a verified improvement, not a confirmed root-cause-and-fix of that exact
measurement. Found by audit: `listAllEmailHeaders()` (the full-sync path used on
first login, one page per `Email/query` + `Email/get` pair) paged in fixed steps
of 200, ignoring `limits.maxObjectsInGet` — the server's own stated batching
ceiling, already respected everywhere else (`getEmailHeaders`, `setEmails` via
`chunkIds`). Against a server permitting more per batch (Stalwart and Fastmail
both default well above 200), that turns a full sync into several times more
round trips than the server would allow in one call — exactly the "looping
per-page instead of batching" shape named as a candidate here.
Fixed: the page size is now `limits.maxObjectsInGet` (500 by default, whatever a
generous server reports otherwise) instead of a hardcoded constant. Same total
messages fetched, same pagination and dedup logic — this changes batch size, not
what gets synced. Regression tests in `providers/jmap/mail.test.ts` pin
contiguous paging at the fixture's limit and confirm a single request suffices
when the server's ceiling comfortably covers the whole mailbox.
What this does **not** rule out: the `Email/query` count is inherent to the
current design regardless of batch size — a full sync fetches every header in
the whole account (all mailboxes, not just Inbox) unconditionally on first
login, so a genuinely huge real-world mailbox will still cost many requests and
minutes, just fewer of each. If the user reproduces this again with a HAR
attached, revisit whether the fix above was sufficient or whether the initial
sync needs to defer non-Inbox mailboxes instead of fetching everything upfront.
The "8 minutes before `DOMContentLoaded`" detail was not explained and is
probably a misreading of the DevTools waterfall — nothing in `sw.ts` or the
bootstrap path blocks on JMAP calls before the page loads (checked: the service
worker has no `fetch` handler, only precaching plus push/notification
handlers), so `DOMContentLoaded` should fire immediately regardless of how long
the background sync runs afterward. (Also: windowed loading for very large
mailboxes is a separate, done item — a 36k-message folder no longer
materialises every header. See the note on mailbox listing in
`gotchas-dexie-performance.md`.)

**T. Bug: folder switcher unreachable on mobile.** The sidebar is
hidden as soon as a mailbox is open on a narrow layout, so a phone was stuck in
whatever folder it entered. `features/mail/MailboxDrawer.tsx` shows the same
`MailboxSidebar` as a left drawer; the trigger sits in the mail list header and
names the current folder, which on mobile is the only thing that does (the
sidebar that would show it is off-screen). Open state lives in `app/store.ts`
because trigger and drawer are siblings — the trigger is in the `$mailboxId`
route, the drawer in the `/mail` layout above it.
Three details: the drawer closes on clicks that reach an `<a>`, which is what
keeps the folder "…" menu usable inside it (that menu stops its own clicks from
bubbling); it closes when the mail layout unmounts, so returning from Calendar
does not find it standing open; and it carries `env(safe-area-inset-bottom)`
because it covers the mobile bottom bar and the sync status was clipped
otherwise. The reading pane keeps its existing back button — one tap to the
list, which has the trigger. Regression: `e2e/mail.spec.ts`, mobile project
only (`test.skip(!isMobile)`).

**U. Mail metadata detail view** (#25). An info button in the reading
pane toolbar (on its own, pushed right — it is the one control there that does
not change the message) opens `MessageDetails.tsx`: an overview from what is
stored locally, then authentication verdicts, the delivery path, notable
headers and every raw header, with "copy headers" and "save original (.eml)".

- **Headers are fetched per open and never cached.** They are not part of
  reading mail, and caching them would park routing data for every message
  anyone ever inspected in IndexedDB. The local half of the dialog therefore
  renders offline and the header sections say why they are missing.
  `EMAIL_METADATA_PROPS` (`id`, `blobId`, `headers`) is deliberately its own
  property set — a full header list is far too much to sync per message.
- **JMAP returns header values folded and with the leading space** (verified
  against Stalwart), so everything goes through `unfoldHeader()`. Parsing lives
  in `domain/messageMetadata.ts`, is pure and tested against a verbatim
  Stalwart sample.
- **`Received:` headers are prepended by each hop**, so the list arrives newest
  first and `deliveryPath()` reverses it — unreversed it reads as if mail flowed
  out of your own server. Clauses are matched *outside* parenthesised comments,
  or `(from userid 1000)` looks like an origin.
- **SPF is evaluated twice** (HELO and envelope sender), so a message normally
  carries two SPF verdicts. `authResults()` therefore reads one verdict per
  semicolon-separated clause and reports the **identity** it applies to
  (`smtp.helo=…`, `smtp.mailfrom=…`, `header.d=…`), folding two entries only
  when method, result *and* identity agree. Without the identity beside them the
  two lines look like the server contradicting itself — which is exactly how the
  user read them. `Received-SPF` is only a fallback.
- **`policy.dmarc=quarantine` is not a verdict** but the policy the sender
  published, and a `\b`-anchored method regex matches it happily (a dot is a
  word boundary), putting a bogus second "dmarc" line next to the real result.
  Reported from a real account. The method must be preceded by a separator —
  written as a character class rather than a lookbehind, since Safari below 16.4
  throws on lookbehind while *parsing* the file and takes the app down with it.
- **The open dialog lives in `app/store.ts` (`messageDetailsOpen`)**, not in
  component state: the mail shortcuts are single keys, and `e` would otherwise
  archive the message *behind* the dialog and navigate away under it. The same
  guard now covers the help overlay. The ReadingPane closes the flag on unmount
  and when another message is opened, since nothing else would.
- **Values are inert monospace text, never links**, clamped past 200 characters
  with a toggle: a header holds whatever the sender wrote, including a URL one
  click from a phishing page and a 4 KB DKIM signature. `emlFileName()` treats
  the subject the same way — path separators, control characters and leading
  dots are stripped before it becomes a download name.
- e2e gotcha: the snackbar sits at `bottom-20` and covers the dialog footer on
  a phone, so the export has to be clicked *before* the copy or the click is
  intercepted.

**V. Rewrite the compose popup** (#26). There was no formatting toolbar
at all before this — StarterKit already bundled bold/italic/underline/strike/
lists/blockquote/link, but nothing in the UI exposed them, so the only way in
was a markdown-shortcut a user would have to already know. `ComposeToolbar.tsx`
adds one, wired to `editor.isActive(...)` for pressed state; it has to re-render
on `onSelectionUpdate` too, not just `onUpdate` — moving the cursor into already-
bold text flips the button with no content change at all.
Found and fixed along the way, not scope creep: a duplicate `Link` extension
(StarterKit already registers one; the separate import was warning on every
mount — configuring the bundled one via `StarterKit.configure({ link: {...} })`
replaced it) and a latent styling bug where Preflight's `list-style: none` on
`ul`/`ol` meant a bulleted or numbered list rendered with no bullet, no number
and no indent inside the editor — invisible to the sender, though the HTML sent
was always correct (the reading pane is a bare iframe outside Tailwind's reset,
so the recipient never saw the bug). Fixed with scoped `.ProseMirror` rules in
`index.css` rather than pulling in `@tailwindcss/typography` for the one rich-
text surface in the app; the `prose`/`prose-sm` classes on `EditorContent` had
been dead weight all along since that plugin was never installed.
Layout: recipient rows gained a persistent label (`To`/`Cc`/`Bcc`) rather than
placeholder-only, and a `Bcc` field now exists — `compose.bcc` was already a
translated string wired to nothing before this, and `saveDraft`'s `fields` type
hardcoded `bcc: []`, dropping it silently even from autosaved drafts.
Everything the issue asked to preserve is unchanged in its own service/hook:
autosave (`saveDraft`), attachments (`stageAttachment`), reply/forward
threading (`ComposeInit`/`buildReply`), offline staging, undo-send (`sendMail`)
— none of those files were touched, only their call sites in `Compose.tsx`.
Regression coverage in `e2e/compose.spec.ts` (desktop-only, real Stalwart send:
bold/italic/list/link round-trip to the recipient's reading pane, plus Cc/Bcc
field independence) — kept to two tests/one send given the 25-mail/hour
Stalwart rate limit (see `e2e-stability.md`).
