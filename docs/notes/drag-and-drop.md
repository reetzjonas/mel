# Drag and drop (mail onto folders, folders into folders)

A pointer-only addition, with the menu, the selection toolbar and the
keyboard shortcuts staying the accessible path. The mobile folder drawer is
deliberately untouched — it is a separate, tap-only surface with no sidebar
to drop onto.

Touch is not actually exempt, though: on a tablet wide enough to show the
sidebar, a long press on a draggable row **does** start a native HTML5 drag
(confirmed on tablet Chrome/Safari). That gesture is also how the browser's
own text-selection/context menu is triggered, so without `select-none` plus
`-webkit-touch-callout: none` plus a `contextmenu` handler on every draggable
row (`draggableTouchClass` / `suppressContextMenu` in `dragAndDrop.ts`), the
browser's menu pops up on top of the drag. Applied to both the mail rows and
the draggable folder rows.

## What moves

- **A mail row onto a folder.** If the row is part of the current selection the
  whole selection goes, because the row is standing in for it; otherwise the
  row's own `ids`, which for a conversation is *this folder's share* of it —
  the same scope its archive and delete already use. Runs through `bulkMove`,
  so the result is one outbox action and an undo in the snackbar.
- **A folder onto another folder**, and onto the **account row**, which stands
  for the top level. Only folders the menu would also offer to move (custom,
  `mayRename`), into only the destinations `moveTargets` allows — the same rule
  the move dialog uses, so the two paths cannot disagree.

## Two things that shaped it

**A drop target may only read the drag's *types*.** The data itself is withheld
until the drop, which is why there are two MIME types rather than one with a
discriminator inside: "may I take this?" has to be answerable from the type
alone. It is also why a mail drop onto the folder it came from is turned away
*on arrival* rather than refused in advance — the origin is not readable until
the drop happens.

**A target that only exists during the drag is the wrong shape.** The first
version showed a dashed "top level" strip while a folder was in flight. It is
hard to aim at something that appears under way, and impossible to hand a drag
to in a test: Playwright's `dragTo` resolves its target *before* the drag
starts, and driving the mouse by hand does not raise HTML5 drag events in
Chromium. The account row was always there; it just had to learn to highlight.

## Touch: `getData` on a custom type comes back empty

Once the context-menu clash above was fixed, dropping a mail row onto a
folder on tablet Safari/Chrome still silently did nothing — the highlight
appeared, so `dragover` was fine, but the move never ran. WebKit (and
apparently others) drop custom-MIME `setData` payloads for a drag that was
*started by touch*: the type still shows up in `dataTransfer.types` — which
is why `dragKind` and the highlight kept working — but `getData(MAIL_DRAG)`
on drop comes back `""`. Folder-onto-folder never hit this, because it never
reads its payload back off `dataTransfer` at all; the dragged folder is kept
in component state (`dragging`) from `dragStart` instead, and the type is
only consulted for the "may I take this" check.

Mail does need the real payload at drop time, so `setMailDrag` now mirrors it
onto `text/plain` too, and `readMailDrag` falls back there when the custom
type comes back empty. `text/plain`'s presence is not used for the
type-only "may I take this" check — only `MAIL_DRAG`/`FOLDER_DRAG` are — so
this doesn't loosen what a target accepts, only how the accepted payload gets
read back.
