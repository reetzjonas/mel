# Design system (since the UI redesign)

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
it is native overlay-scrollbar behaviour and not a fault — measured together with the
user: `offsetWidth - clientWidth` is **0px** on their machine, so Chrome is drawing
overlay scrollbars, thin and faint at rest, thicker while the pointer is in the scroll
area, returning on its own. Resolved by softening the thumb (`--mel-scrollbar`) rather
than taking the bar over: whether it reserves layout width is a platform preference —
the same rules measure 10px in a headed browser here and 0px on a machine set to
overlay — and overriding that costs 10px of sidebar to overrule a choice the user made
for every app they run. With both properties present, the standard ones win and
`::-webkit-scrollbar` is ignored (Chrome ≥121); a 24px webkit rule yields 24px on its
own but 10px alongside `scrollbar-width: thin`. So taking the bar over would mean
dropping the global standard-property block for Chrome and keeping it for Firefox
only.

HTML mail deliberately renders on white (senders hardcode dark text);
**plain-text mail** follows the app theme (`textFrameDoc` is handed the colours).

**Hover swaps must be height-neutral.** In the folder list the unread counter is
swapped for the "…" menu button on hover; that button was taller than the badge, so
every row below jumped by 3px. Both now sit in a fixed 20px box and the row has
`min-h-[34px]` plus `leading-5`. Regression: `e2e/navigation.spec.ts` measures every
row with and without hover.
