# Theme editor (issue #19)

Settings → Appearance → Colours. Four sliders: accent hue and intensity,
surface hue and tint. Everything applies as it is dragged — there is no Save,
and no preview swatch, because the app behind the dialog is the preview.

## Why four controls and not nineteen

The palette's readability lives in its **lightness ladders**: `canvas →
surface → raised` and `ink → ink-muted → ink-subtle`. Turning hue and chroma
leaves every rung exactly where it was. Exposing each token separately would
hand someone a way to make their own mail unreadable one slider at a time.

`L` is therefore never offered, and that single decision is what satisfies the
issue's "preserve contrast" requirement structurally rather than by warning
after the fact.

The model is still a map of token overrides (`deriveOverrides`), so a later
"advanced" section would only be a second way to fill it, not a rewrite. The
user asked to start guided and keep that door open.

## What is deliberately not tunable

`--mel-danger`, `--mel-success` and `--mel-honey`. Their hue *is* their
meaning — a green "delete" or a violet "unread" would be a bug wearing the
clothes of a preference. `e2e/theme-editor.spec.ts` picks an accent hue of
200° on purpose when checking this: clear of danger (25), honey (72) and
success (150), so "untouched" and "retinted" cannot look the same. The first
draft used 150 and proved nothing.

## Contrast is measured, not promised

Holding `L` steady keeps *perceptual* lightness, but WCAG's figure is computed
from the sRGB primaries weighted 0.2126/0.7152/0.0722 — so saturation moves it
too, by a little. The editor shows four real ratios for the pairs a mailbox is
actually read through, not a claim derived from the ladder. `lib/oklch.ts` does
the conversion; it is hand-rolled because it is four matrix multiplications and
a gamma curve, all exactly specified, and the project already declines CDN
dependencies for smaller reasons.

Out-of-gamut colours give up **saturation, not hue**. Left to the browser an
impossible colour is clipped per channel, which drags the hue elsewhere — a
blue someone picked comes back purple. Reachable chroma depends on both hue and
lightness, and the ordering flips: a dark blue reaches 0.206 where a dark
yellow manages 0.072, while a pale yellow reaches 0.128 against a pale blue's
0.048. That is why the sliders may ask for more than the screen can show and
the clamp sorts it out, rather than a single "maximum chroma" that would be
wrong at most hues.

## Two traps in the wiring

**The base palette must be read with our own overrides lifted.** Tokens are
read back through `getComputedStyle`, so leaving the previous pass in place
would retint its own output and the colour would drift further on every slider
move instead of tracking the slider. `readBasePalette` removes them first.

**Overrides go on the root element, not on `body`.** `@theme` declares
`--color-accent: var(--mel-accent)` at `:root`, and a custom property resolves
where it is *declared*. An override further down the tree would be inherited by
nothing that matters.

The tuning is re-derived on every theme change rather than once at startup:
light and dark share their hues but not their lightness, so the overrides are
built from whichever palette is in force. `ThemeProvider` does that; carrying
the light values into dark mode would wash the whole app out.

## Resetting

Forgets the tuning rather than storing today's defaults — "no opinion" has to
keep following the palette, or a later redesign would silently not reach anyone
who had ever opened this screen. Same rule as the panel widths, and for the
same reason.
