# Resizable panel widths (issue #17)

Two boundaries, both only at `lg` and above: folder sidebar against the rest
(`app/routes/mail.tsx`), message list against the reading pane
(`app/routes/mail.$mailboxId.tsx`). Below `lg` the panes take turns filling the
screen, so there is nothing to move and the handles are `display: none` — a
width dragged on a desktop cannot reach the phone layout, because the class
carrying it (`lg:w-[var(--mel-panel-w)]`) simply does not apply there.

Per device, in `localStorage` (`mel:panel:sidebar`, `mel:panel:list`), not per
account: the reason to widen the folder list is the screen it is read on, and
that does not change when a different account is opened on the same machine.

The decisions live in `features/mail/panelWidths.ts` — clamping, storage, the
keyboard steps — so they are testable without a DOM. `ResizeHandle.tsx` is the
control.

## Three things that shaped it

**A stored width is only as good as the screen it was stored on.** Carry a
laptop away from a wide monitor and a 720px message list leaves nothing for the
message. So no panel may take more than half the row it shares, and that
ceiling beats the configured maximum — but never the minimum, since a 40px
folder list is not a smaller folder list, it is none.

**The handles must cost no layout.** They were a 4px strip each at first, and
being flex children they also earned the row's 12px gap on both sides: 16px per
boundary, 32px across both. The reading pane's action labels hang off a
container query at 768px, so at a 1440px window that quietly pushed it under
the threshold and the buttons went back to icons. Caught by `mail.spec.ts`,
which measures exactly that. They are now as wide as the gutter with negative
margins cancelling their own gaps (12 - 12 + 12 - 12 + 12 = 12, what the gap
cost before), so they cover the gutter instead of adding to it. A real width
rather than zero plus an overflowing child: a control with no bounding box is
one that hit-testing, assistive technology and Playwright all struggle with,
however well the pointer events happen to bubble.

**`pointercancel` carries no position, and Chrome sends one.** Without
`preventDefault()` on `pointerdown` the browser starts selecting text on the
first move and abandons the pointer sequence — measured: exactly one
`pointermove` arrives, then a cancel with `clientX: 0`. Recomputing the width
from that event gave `384 + (0 - 638)`, i.e. -254, which clamped to the
minimum: **the panel collapsed whenever a drag was interrupted.** Two fixes,
both needed. The gesture is claimed on pointerdown so the cancel stops
happening, and the end of a drag commits the width last *previewed* rather than
recomputing from the event, so an interruption from any other cause keeps what
was on screen.

The unit test had asserted the opposite, because it handed the cancel a
plausible `clientX` that no browser sends. It now uses the zero that Chrome
actually delivers. Worth remembering the shape of that mistake: a test can pass
for the reason it was written rather than the reason it exists.

## Resetting

Settings → **Appearance** → Panel widths. Its own tab rather than a section of
General: the theme editor (#19) lands beside it and will want the room, and
splitting theme across two tabs would have been worse than moving it.

The button is `disabled` while there is nothing stored — a handler that returns
early belongs behind a visible `disabled` (see `e2e-stability.md`), and here
the state is genuinely knowable.

Resetting *forgets* the preference rather than storing today's default: "no
opinion" and "wants exactly 384px" are different, and only the first one
follows a later change to the default.

That is also why the widths are a small store (`useSyncExternalStore`) rather
than component state. The settings dialog opens *over* the mail screen rather
than replacing it, so the panels behind it are mounted — component state would
have needed a reload, which is a heavy answer for a width. Covered end to end:
widen, reset from settings, no reload.

## Performance

The drag writes `--mel-panel-w` straight to the panel element and only tells
React on release. Committing per pointer move would re-render the message list
on every pixel, and that list is virtualised precisely because it can hold tens
of thousands of rows.

## Accessibility

`role="separator"` with `aria-orientation`, `aria-valuenow/min/max` and a label
— the WAI-ARIA window-splitter pattern, which screen readers announce with the
current width. Arrow keys move it (Shift for a finer step), Home and End go to
the extremes, and a double click resets it *and* forgets the stored preference,
which are different things: "no opinion" must not become "wants exactly the
current default", or a later change to that default would silently not apply.

Keys the handle does not use are left alone rather than swallowed — it sits in
the tab order, and eating Tab would trap focus on a twelve-pixel strip.

Touch is covered by the same code: pointer events plus `touch-action: none`, so
a drag on a tablet wide enough to show both panes works and does not scroll the
page instead.
