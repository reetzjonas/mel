# Files (JMAP FileNode)

A fourth app beside Mail, Contacts and Calendar: browse folders, upload, create
folders, rename, move, delete, preview, and tick several items to move,
download or delete them together. It rests on `urn:ietf:params:jmap:filenode`,
a **draft** (`draft-ietf-jmap-filenode`, -14 at the time of writing) that few
servers implement — so the tab only exists when the account advertises the
capability, and `connection.files` is null otherwise.

The dev Stalwart (0.16) implements it, and its `accountCapabilities` entry
matches -14 field for field.

## Shape

| Layer | Where |
| --- | --- |
| Domain object | `src/domain/file.ts` |
| JMAP provider | `src/providers/jmap/files.ts`, `mappers/files.ts` |
| Local mirror | `db.files`, synced in `sync/engine.ts` like any other collection |
| Writes | `src/services/files.ts` |
| UI | `src/features/files/`, routes `files.tsx` / `files.index.tsx` / `files.$folderId.tsx` |

Node metadata syncs into IndexedDB, so browsing works offline and delta sync
comes from the shared `syncCollection`. File **contents** do not: they stay on
the server and are fetched on demand, like mail attachments.

### parentKey, not parentId

`FileNodeRow` stores the parent as `parentKey`, with `''` for "top level",
because IndexedDB **skips a record whose indexed key is null**. Storing the
domain object's nullable `parentId` would have left every root node out of the
one index the folder listing is built on, and the root would always have looked
empty. (`mailboxes` declares the same `[accountId+parentId]` index and gets
away with it only because nothing ever queries it — the folder tree is built in
JS from the whole account.)

### Writes are server-first

No outbox action, unlike mail, contacts and calendar. The content has to reach
the server for the write to mean anything, and a queued upload would park the
whole file in IndexedDB — a 50 MB payload in a table built for
`keywords/$seen` patches. So `services/files.ts` reports failure to the caller
and `syncFileTree()` brings the local mirror back in line afterwards. That is
also why the sync engine grew a public entry point for this one collection:
running the whole account sync behind a folder rename would drag every message
header along with it.

## Selecting, moving, dragging

The row icon doubles as the checkbox, exactly as the avatar does in the mail
list, and a selection swaps the toolbar for a selection one carrying Move and
Delete. That swap is also what made deleting *findable*: the per-row buttons
were hover-only at first and the first person to use the app reported deleting
as missing outright. They are still there, but below `lg` — where there is no
hover — they are simply always visible.

Three things about that checkbox were wrong first time round, and all three
were reported from an actual window rather than caught by a test:

**Always-on below `lg` was the wrong fix.** Making the checkbox permanently
visible on narrow widths meant its opaque box sat on top of the file icon, so
shrinking the window turned every row into what looked like a ticked one. The
checkbox is revealed by hover on a desktop and by an explicit **Select** button
otherwise — the toolbar toggle is also the only way to start selecting with a
finger, since touch has no hover to reveal anything. While it is on, tapping
anywhere in a row ticks it instead of opening it; a 17px box is not a touch
target.

**`group-hover` is not the same as `hover`.** Revealing the checkbox whenever
the pointer was anywhere in the row read as the folder icon vanishing as the
mouse went past. The mail list had already learned this about the avatar; the
comment there says so, and it was still copied wrong.

**A `draggable` element swallows clicks on the controls inside it.** Pressing
the checkbox and moving a single pixel starts a drag instead of ticking, which
made selecting with a mouse essentially impossible — reported as "I always end
up in move mode". The row now stops being draggable while the pointer is over
the checkbox or the row actions, so it is dragged by its name. Chromium raises
no drag events for a synthetic mouse, so the gesture cannot be reproduced in
Playwright; `files.spec.ts` asserts the `draggable` attribute flipping instead,
which is the mechanism rather than the symptom.

Shift-click takes the run between the last row ticked on the anchor and the one
clicked, in **both** Files and the mail list (`ThreadList.pickRow`). It only
ever adds: a range that also cleared rows would undo deliberate ticks it
happened to cross. The anchor is a ref in both places — nothing renders from it,
and the mail list already goes to some length not to re-render on selection
changes. In mail the run is measured over rows as displayed, so a conversation
counts once, matching what `j`/`k` already do.

Moving works three ways, and they share `moveTargets` in `tree.ts` so they
cannot disagree: the Move dialog, dragging a row onto a folder row, and
dragging onto a **breadcrumb** crumb. The last one is not decoration — the
listing only shows a folder's children, so without it there is no way to aim
at a folder *above* the one being viewed. A folder may never be dropped into
itself or its own descendants; the server would be left holding a cycle with
no path to the root.

Drag and drop reuses `lib/dragAndDrop.ts` rather than keeping a second copy: every touch lesson in `drag-and-drop.md` applies here unchanged,
including the two that cost the most — the in-flight payload is kept in module
state because `dataTransfer` cannot be read during a touch drag, and what is
being dragged lives in a `useRef`, since a touch drag can fire `dragenter`
before any React render commits.

## Preview, and the full view

`FilePreview` renders images, text and PDFs from a blob URL it makes and
revokes itself. In the pane that is fine for a photo and useless for a PDF: the
pane is 24rem beside the listing and a phone's width below `lg`, and an A4 page
at that width is not readable. **Full view** puts the same content over the
whole window, closed by Escape, by the backdrop or by its own button.

Two deliberate choices in there:

**An overlay, not a new tab.** `window.open(blobUrl)` was the obvious route and
is the fragile one: Safari refuses a top-level navigation to `blob:`, and in an
installed PWA a new tab drops the user out of the app into a browser window.
The overlay also keeps the blob URL owned by the component that revokes it,
rather than handing it to a tab that may outlive the preview.

**One viewer mounted at a time.** The pane's body is unmounted while the
overlay is open (`{!expanded && <PreviewBody …/>}`). Leaving it there would have
the browser running two copies of the same PDF, and nothing of the pane shows
from under a full-window overlay anyway.

`PreviewBody` is one renderer with a `full` flag rather than two: only the
bounds differ. The one that matters is the image — `max-h-full object-contain`,
so a tall image is fitted to the window instead of running off the bottom of
it, which is the whole point of asking for a bigger view.

## Downloading more than one thing

A browser saves one file at a time and a folder not at all, so the selection
toolbar's **Download** packs whatever is ticked into a single zip: files as
they are, folders walked to the leaves. Single-file download stays where it
was, in the preview pane — that case needs no archive and no library.

The tree for the walk comes from the server (`FileNode/query` + `/get`), not
the local mirror, for the same reason the recursive delete does: a stale copy
misses exactly the child that matters, and here that means quietly leaving a
file out of an archive somebody is about to keep.

`archive.ts` splits into the path maths and the zip writing, because only the
first needs testing against awkward trees and only the second needs the
dependency. Three decisions in there:

**An empty folder gets an entry of its own** (`name/`), since nothing else can
carry it — a zip without it is a zip where the folder never existed. A symlink
gets none: the target is a property mel does not read (#77), so writing it
would claim the content was empty rather than elsewhere.

**A file that cannot be read is written empty rather than dropped.** Half an
archive that says so beats a whole one that quietly lost a file.

**Compression only where it pays.** Deflate runs on the main thread, so it is
spent on text and skipped for a JPEG or a PDF, which are already compressed and
would cost a pause for a percent. fflate's async path would move the work off
the thread, but it builds a Worker from a blob URL — a dependency on a CSP that
allows that, for a saving nobody would notice.

`fflate` is the one new dependency (~11 kB as built, its own chunk) and it is
behind `await import(...)`, so it is fetched the first time somebody downloads
a selection and never on the path into the app. It is also what the e2e test
reads the downloaded file back with: the assertion opens the zip and checks the
paths inside it, rather than trusting a `.zip` suffix.

## Symlinks: shown, never followed

`FileNodeType` has claimed `'symlink'` since the first version of this app,
while the mapper read no target at all — a type promising something nothing
handled (#77). The target is now read and shown: the row and the preview pane
say `Link → notes/today.txt`, with the draft's own spelling of a path (a
leading empty element means absolute within the account, `..` steps up, and the
target need not exist — dangling links are allowed).

**Following one is deliberately not implemented.** The draft puts the work on
the client: resolve the path yourself, guard against a link pointing at its own
ancestor, and never leave the FileNode tree. None of that could be tried
against anything here, because **Stalwart does not implement symlinks at all**:

- A create with `nodeType: "symlink"` and a target **succeeds** and stores a
  **directory** with `target: null`. No error.
- The reason is that Stalwart **derives the node type from the blob**: a create
  with `blobId: null` is a directory whatever `nodeType` says, and setting
  `type` on it is then refused with "size, type and executable may only be set
  on file nodes".

So a symlink cannot be created, received or tested here, and the honest version
is the small one: keep whatever a conforming server sends, show where it
points, and say in the pane that mel does not follow it. There is no e2e test
for it for the same reason — the server cannot produce the case.

While that was in hand: **a node with no content used to leave the preview on
"Loading…" for as long as it was open.** `readFile` returns null for a node
without a blob, and the pane had no state to move to. It now says the file
cannot be previewed, which is true of a symlink and of any content-less node.

## The executable bit, and the two flags next to it

`executable` is read into the domain object and shown as a checkbox in the
preview pane, the one place only files reach (clicking a folder navigates into
it). Nothing in a browser runs anything, so this is for the other end of the
store — the same tree mounted as a folder on a machine, where the bit is the
difference between a script and a text file. Stalwart takes it in a
`FileNode/set` update like any other property.

The tick flips before the write finishes and is put back if the server refuses,
because a round trip here is a request *plus* a full tree sync; a checkbox that
sits still that long reads as broken. It is state beside the synced value
rather than a lone `useState`, so the pane follows the node when the listing
changes underneath — see the two-field state in `FilePreview`.

The e2e assertion for it reloads the page and reopens the file: an optimistic
tick proves nothing on its own, and a fresh page has nothing to go on but what
the server hands back. Stashing the write turns that assertion red, which is
how it was checked.

The other two properties from the same issue (#78) are deliberately **not**
surfaced, both for reasons found by asking the server rather than by reading
the draft:

**`accessed` is an atime, and it ticks on the read itself.** Two
`FileNode/get` calls two seconds apart come back with two different values and
the *same* state string. Whatever it is stored as, a client can never display
anything but "just now", and keeping it would rewrite the row on every sync for
a value that carries no information.

**`isSubscribed` is read-only here.** Stalwart reports it as `true` on every
node and refuses to change it: `invalidProperties`, "Field could not be set."
A toggle would be a control that does nothing, and hiding nodes on a flag that
is always true would be a filter nobody can turn off.

## What the server does that the spec does not say

Each of these cost a round of probing; none is guessable from the draft.

**The blob id you upload is not the blob id you get back.** Upload answers with
one id, and the node created from it carries a different one — the server
re-addresses the content on store. So reading a file must use the `blobId` from
a *fetched node*, never the one the upload returned. `readFile` takes the whole
node for exactly this reason.

**`/set` answers a create with `{id}` and nothing else.** The spec says the
server returns every property it set itself; Stalwart returns the id alone. So
`size`, the real `blobId` and the timestamps only appear after a follow-up
fetch — which is what `syncFileTree()` does after every write.

**A parent and its child in one destroy call fails both.** The child comes back
`willDestroy` and the parent `nodeHasChildren`, and no ordering inside the array
helps. `deleteNodes` therefore groups the subtree by depth and sends one call
per level, deepest first. The provider's `destroyNodes` stays a straight
pass-through and does not recurse.

**`parentId: null` is not how you ask for the top level.** That is the separate
`isTopLevel: true` filter condition; a null parent in a query is refused.

**An unsupported filter condition is ignored, not refused.** `{role: 'trash'}`,
`{hasAnyRole: false}` and `{totalNonsense: 1}` each return the *unfiltered* set
rather than `unsupportedFilter`, so a query built on a condition the server does
not implement looks like it matched everything instead of failing. `role` and
`hasAnyRole` are in that group — `role` is a TODO on both sides in Stalwart
(discarded on write, ignored in queries), which is why mel has no concept of
server-assigned folder roles; see issue #76. `parentId`, `isTopLevel` and
`ancestorId` are honoured.

**A file may be created with no blob at all.** The draft calls `blobId` required
for `nodeType: "file"`, Stalwart accepts it as null — so a file node in the wild
may have no content, and `readFile` returns null rather than assuming.

**`alreadyExists` carries the colliding node's id** in an `existingId` property
the generic `SetError` shape does not have. Worth reaching for if a caller ever
wants find-or-create in one round trip instead of query-then-create.

## Testing

`e2e/files.spec.ts` drives the real flow against Stalwart: create a folder,
upload into it, assert the size the *server* reports (which is what proves the
content was stored rather than an empty node created), preview, rename, then
delete the folder whole. Desktop-only, like every other state-mutating spec.

`e2e/global-setup.ts` purges file nodes as part of the reset, deepest level
first. Without that, a run that fails before its own cleanup leaves uploads
behind for the next one — the accumulation described in `e2e-stability.md`,
which is exactly how it was found here.

Below `lg` the preview replaces the listing instead of sitting beside it. The
first version had it `hidden lg:flex`, so on a phone tapping a file appeared to
do nothing at all; the mobile Playwright project caught it.

**Every button in a row carries the node's name** — `note.txt`, `Rename
note.txt`, `Delete note.txt` — so a screen reader hearing "Delete" ten times in
a row can tell them apart. The cost lands on the specs: `getByRole` matches the
name case-insensitively **as a substring**, so `{ name: 'note.txt' }` resolves
to all three and `{ name: folder }` also caught `Delete <folder>`. Every row
selector here passes `exact: true`, and the row actions are reached by
`/^Delete /` inside a `filter({ hasText })`. Same trap as the one already in
`gotchas-testing.md`, met from the other direction.

The move dialog has `role="dialog"` so its folder buttons can be addressed
apart from the identically named rows behind it.
