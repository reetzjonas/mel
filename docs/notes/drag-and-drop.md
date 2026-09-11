# Drag and drop (mail onto folders, folders into folders)

A pointer-only addition. The menu, the selection toolbar and the keyboard
shortcuts do the same two jobs and stay the path for keyboard and touch —
HTML5 drag and drop does not fire on touch at all, so the mobile folder drawer
is deliberately untouched.

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
