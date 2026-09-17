# Drag and drop (mail onto folders, folders into folders, files, events on the grid)

The plumbing is `src/lib/dragAndDrop.ts` — shared, not mail's, since Mail and
Files both drag through it. It lived under `features/mail/` until #51 for no
reason but where it grew up, and Files reached across into a sibling feature
to use it.

A pointer-only addition, with the menu, the selection toolbar and the
keyboard shortcuts staying the accessible path. The mobile folder drawer is
deliberately untouched — it is a separate, tap-only surface with no sidebar
to drop onto.

Touch is not actually exempt, though: on a tablet wide enough to show the
sidebar, a long press on a draggable row **does** start a native HTML5 drag
(confirmed on tablet Chrome/Safari). That gesture is also how the browser's
own text-selection/context menu is triggered, so without `select-none` plus
`-webkit-touch-callout: none` plus a `contextmenu` handler on every draggable
row (`draggableTouchClass` / `suppressContextMenu` in `lib/dragAndDrop.ts`), the
browser's menu pops up on top of the drag. Applied to both the mail rows and
the draggable folder rows.

## What moves

- **A mail row onto a folder.** If the row is part of the current selection the
  whole selection goes, because the row is standing in for it; otherwise the
  row's own `ids`, which for a conversation is _this folder's share_ of it —
  the same scope its archive and delete already use. Runs through `bulkMove`,
  so the result is one outbox action and an undo in the snackbar.
- **A folder onto another folder**, and onto the **account row**, which stands
  for the top level. Only folders the menu would also offer to move (custom,
  `mayRename`), into only the destinations `moveTargets` allows — the same rule
  the move dialog uses, so the two paths cannot disagree.

## Two things that shaped it

**A drop target may only read the drag's _types_.** The data itself is withheld
until the drop, which is why there are two MIME types rather than one with a
discriminator inside: "may I take this?" has to be answerable from the type
alone. It is also why a mail drop onto the folder it came from is turned away
_on arrival_ rather than refused in advance — the origin is not readable until
the drop happens.

**A target that only exists during the drag is the wrong shape.** The first
version showed a dashed "top level" strip while a folder was in flight. It is
hard to aim at something that appears under way, and impossible to hand a drag
to in a test: Playwright's `dragTo` resolves its target _before_ the drag
starts, and driving the mouse by hand does not raise HTML5 drag events in
Chromium. The account row was always there; it just had to learn to highlight.

## Touch: `dataTransfer` cannot be trusted mid-drag at all

Once the context-menu clash above was fixed, dropping a mail row onto a
folder on tablet still silently did nothing — and confirmed on the device:
no highlight either, so this was a `dragover` failure, not a `drop` one.
The first guess was that `getData` alone was unreliable on a touch-started
drag (a real WebKit quirk elsewhere) and that `dragover`'s `dataTransfer.types`
was fine; a mirrored `text/plain` payload shipped on that basis and did not
fix it. The actual failure was one layer earlier: on tablet, `dragover`'s own
`e.dataTransfer.types` can come back **empty**, so `dragKind` had nothing to
read and every drop target refused the hover before a payload ever mattered.

The fix moves what a drag _is_ out of `dataTransfer` entirely: `dragstart` is
the one lifecycle event that has proven reliable on touch, so `setMailDrag`/
`setFolderDrag` now record the kind and the mail payload in module state in
`lib/dragAndDrop.ts`, cleared on every `dragend` (`clearDragState`). That state
is one entry — `{kind, payload}` — rather than a variable per kind, because
each new kind used to mean remembering to clear one more of them, and a
payload nobody cleared is one a later foreign drag can read. `dragKind`
still checks `dataTransfer.types` first — keeping desktop and the Playwright
`dragTo` coverage, which drives real `dataTransfer`, exactly as before — and
only falls back to the recorded kind when `types` comes back empty, so a
drag from outside the app (which leaves both `types` and the module state
empty) still reads as nothing.

That module state is a landmine for read order, though: `onDropOn` used to
call `endDrag()` — which now also clears it — _before_ `readMailDrag(e)`, so
on touch (where the fallback is what `readMailDrag` actually needs) the
payload was already gone by the time it was read, and the highlight worked
while the move silently did not. Read it before clearing it, not after.

## Touch: a `useState` closure is not fast enough either

Fixing mail did not fix folders: dragging a folder onto another still never
highlighted anything on tablet, and the note above had it backwards —
folder-onto-folder was never dodging the `dataTransfer` problem, it has its
_own_ version of it, in `dragging`, the component state tracking which
folder is in flight (read by `takes`/`folderTargetsFor` to compute valid
drop targets, and by the account row and `onDropOn` for the move itself).

`onDragStart` sets it with `setDragging(m)` — a React state update, which
only becomes visible to closures after the next render commits. On a mouse
drag there is always a `dragover` or two before the pointer reaches a target,
plenty of time for that render. On a touch-started drag, the browser can fire
`dragenter`/`dragover` on the very first element under the finger essentially
back-to-back with `dragstart`, with no render in between — so `takes` keeps
reading the pre-drag `null` for the entire gesture and nothing ever
highlights, exactly the shape of the mail bug one layer up.

`dragging` is now a `useRef` (`draggingRef`) instead: nothing here is ever
rendered from its value, only read inside event handlers to decide what to
do, which is exactly what a ref is for. A ref's `.current` is shared across
every closure regardless of which render created them, so `onDragStart`
writing it synchronously is enough — no render has to land in between for
`onDragOver` to see it.

## Touch: a draggable folder cannot be an `<a>` at all

Still not done: with the highlight fixed, holding a folder long enough on
tablet handed back WebKit's _own_ link-drag — the little lifted-card preview
Safari shows for a long-pressed link — and releasing it just opened the
folder like a normal tap, our `dragstart`/`dataTransfer` handling never
entering the picture. A folder row is `<Link>`, i.e. an `<a>`, and WebKit's
built-in dragging of links and images does not go through
`draggable`/`ondragstart` the way a plain element's does — it owns the touch
gesture outright unless told otherwise.

The first attempt was `-webkit-user-drag: element`, the CSS switch that tells
WebKit to defer to the page's own drag-and-drop instead of its built-in one.
It did kill the link-lift and the open-on-release — but folder-onto-folder
still never highlighted anything, and neither did folder-onto-the-account-row,
a plain `div` with no link-related history at all. That ruled out the drop
side entirely: a drag _started_ from a folder raised `dragover` on nothing,
not even a target that had never had an anchor problem. `-webkit-user-drag`
changes what WebKit's own drag interaction hands over on drop; it does not
make an anchor-sourced touch drag join the page's normal
`dragenter`/`dragover`/`drop` cycle for other elements the way a drag from a
plain element does — confirmed on-device, not just inferred from the docs.

The actual fix is to stop asking `<a>` to do this at all. A folder row that
can be dragged (`canDrag`) now renders as a `div` (`role="link"`, `tabIndex`,
its own `onClick`/`onKeyDown` calling `navigate()`) instead of `<Link>` —
exactly the element mail rows already were, which is why mail never had any
of these problems. A non-draggable folder (a role folder, or one without
`mayRename`) stays a real `<Link>`, since it never becomes a drag source and
keeps the native affordances (open-in-new-tab, etc.) a real link gets for
free. The active-route highlight, previously `Link`'s own `.active` class, is
now computed by hand from `useParams({ strict: false })` so both branches
render identically — the same comparison the router's own match was making,
read directly instead of through the `<a>` it no longer is. With no draggable
row left as an anchor, `-webkit-user-drag` went back out of
`draggableTouchClass` — it never did anything for the mail row's plain `div`,
and there is no longer a `Link` left for it to matter to.

## The label's frame, and why it is a border (2026-09-12)

The drag label carried a `ring-2 ring-accent`, and on screen that showed up as
four violet corner brackets with no sides — reported as "the frame around the
items I'm dragging looks odd", with a screenshot that made it obvious.

`setDragImage` takes a snapshot that clips at the **border box**, and Tailwind's
`ring` is a box-shadow _outside_ it. The straight edges fell entirely outside
and were cut away; only the rounded corners still reached far enough inward to
leave a fragment. `shadow-raised` was clipped the same way and had been doing
nothing there but costing a repaint.

A `border` is part of the box and survives the snapshot. Pinned in
`dragAndDrop.test.ts`, because the reason is invisible in review and `ring` is
the idiom everywhere else in this codebase — the next person tidying up will
reach for it again.

## Calendar events (issue #28)

Two grids, two mechanisms, for a reason.

**Week and day** use pointer events with capture, not HTML5 drag: the grid
needs a live preview of where the block is heading and what length it will
have, and a native drag gives you a ghost image and nothing to position. Both
edges resize as well as the whole block moving.

**Month** uses the same HTML5 drag as mail onto folders, because that is the
shape it is: chips picked up and dropped onto day cells, with the cell
highlighting as a target. There is no time axis to preview, so a drop can only
mean "this day instead" — the time and the length are kept.

The arithmetic is in `features/calendar/dragGeometry.ts`, away from the pointer
handling, so snapping, the edges of the day and a block dragged inside out are
all decided in one pure function with tests. `lib/recurrence.ts` turns the
dropped instants back into a stored event.

### What may be dragged, and what may not

- **A series may not.** mel cannot yet override a single occurrence (#5), so
  dragging one instance would move every one of them — and on a rule with
  `byDay`, dragging it to another weekday would do nothing visible at all,
  because `dtstart` moves and the rule does not.
- **A birthday may not.** It is not an event on any server, and its day comes
  from the contact card.
- **An invitation may not.** Somebody else organizes it; the dialog already
  refuses to edit one.
- **An event running past midnight may not.** It is already drawn as a block
  overflowing its column, and a drag would have to decide which day it belongs
  to.

The affordance carries this: a movable block gets `cursor-grab`, everything
else stays on `cursor-pointer`.

### Undo

A drag rewrites `start` and `duration` and nothing else, so the snackbar's undo
simply writes the event back as it was — exact, rather than an inverse someone
has to keep correct as the model grows.

### Three things that shaped it

**Claim the gesture on `pointerdown`.** Same trap as the panel handles
(`panel-widths.md`): without `preventDefault()` the browser starts selecting
text on the first move and abandons the sequence with a `pointercancel`.

**A cancelled drag is discarded, not committed.** The opposite of the panel
handle, and deliberately: that one writes a local width, this one writes to the
server. What is on screen mid-drag is a proposal, not a decision.

**Build the dropped time from calendar fields.** A day is not always
86,400,000 ms long. Adding a day's worth of milliseconds to move an event
across the end of summer time lands it an hour out, which is why `instantAt`
asks for "that date at that minute" instead. The reverse direction matters just
as much: the grid is the _viewer's_ wall clock and the event keeps its own, so
`rescheduleEvent` reads the instant back in the event's zone. A 10:00 Berlin
meeting dragged while the calendar is read in London still stores 10:00.

### Touch

Not offered: a drag would fight the grid's own scrolling, and a phone never
sees this grid anyway (the week and day views are `sm` and up). Tapping a block
opens the dialog, which is the way to move an event by hand.
