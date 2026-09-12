import { useCallback, useSyncExternalStore } from 'react'
import {
  clampToSrgb,
  contrastRatio,
  formatOklch,
  gradeContrast,
  parseOklch,
  type ContrastGrade,
  type Oklch,
} from '../lib/oklch'

/**
 * The guided theme editor: a few decisions, applied across the palette.
 *
 * What it does *not* offer is per-token editing, and that is the point. The
 * palette is built on lightness ladders — canvas → surface → raised, ink →
 * muted → subtle — and those ladders are what makes text readable. Turning
 * hue and chroma leaves every rung where it was; letting each token move
 * freely would hand someone a way to make their own mail unreadable one
 * slider at a time. Raw tokens can still be added later: everything below
 * works on a map of overrides, and per-token editing would only be a second
 * way to fill it.
 */

export interface ThemeTuning {
  /** Degrees, 0–360. */
  accentHue: number
  /** Multiplier on the shipped chroma; 1 is as designed. */
  accentChroma: number
  surfaceHue: number
  surfaceTint: number
}

/** Everything the accent hue reaches. */
const ACCENT_TOKENS = [
  '--mel-accent',
  '--mel-accent-hover',
  '--mel-accent-ink',
  '--mel-accent-wash',
] as const

/** The neutrals: the surfaces you look at and the ink you read. */
const SURFACE_TOKENS = [
  '--mel-canvas',
  '--mel-surface',
  '--mel-surface-2',
  '--mel-raised',
  '--mel-line',
  '--mel-line-strong',
  '--mel-ink',
  '--mel-ink-muted',
  '--mel-ink-subtle',
  '--mel-scrollbar',
] as const

/*
 * `--mel-danger`, `--mel-success` and `--mel-honey` are deliberately absent.
 * Their hue *is* their meaning — a green "delete" or a violet "sent" would be
 * a bug wearing the clothes of a preference.
 */
export const TUNED_TOKENS = [...ACCENT_TOKENS, ...SURFACE_TOKENS]

export type TunedToken = (typeof TUNED_TOKENS)[number]

/** Which family a token belongs to, and so which pair of controls moves it. */
function familyOf(token: string): 'accent' | 'surface' {
  return (ACCENT_TOKENS as readonly string[]).includes(token) ? 'accent' : 'surface'
}

/**
 * The same colour under a new hue and a scaled chroma.
 *
 * Lightness and alpha are carried over untouched: `L` is what the ladders are
 * made of, and the alpha on `--mel-accent-wash` and `--mel-scrollbar` is what
 * keeps them washes rather than fills.
 */
export function retint(base: Oklch, hue: number, chromaScale: number): Oklch {
  return clampToSrgb({
    l: base.l,
    // A token that ships grey stays grey however the sliders move — scaling
    // zero is still zero, which is right for a pure white surface.
    c: Math.max(0, base.c * chromaScale),
    h: ((hue % 360) + 360) % 360,
    alpha: base.alpha,
  })
}

/**
 * The overrides a tuning produces, given the palette as the stylesheet has it.
 *
 * Base values come in as text because that is how they leave CSS. A token
 * that cannot be parsed is left out rather than guessed at, so a future
 * palette using a colour space this does not read degrades to "unchanged"
 * instead of to something invented.
 */
export function deriveOverrides(
  base: ReadonlyMap<string, string>,
  tuning: ThemeTuning,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const token of TUNED_TOKENS) {
    const parsed = parseOklch(base.get(token) ?? '')
    if (!parsed) continue
    const accent = familyOf(token) === 'accent'
    const hue = accent ? tuning.accentHue : tuning.surfaceHue
    const scale = accent ? tuning.accentChroma : tuning.surfaceTint
    out.set(token, formatOklch(retint(parsed, hue, scale)))
  }
  return out
}

export interface ContrastCheck {
  /** i18n key naming the pair, e.g. body text on the page background. */
  labelKey: string
  ratio: number
  grade: ContrastGrade
}

/**
 * The pairs worth reporting, measured rather than assumed.
 *
 * Four, not forty: these are the ones a mailbox is actually read through, and
 * a list long enough to scroll is a list nobody checks. Body text first,
 * because that is the one that must never slip.
 */
const CHECKED_PAIRS: ReadonlyArray<[string, TunedToken, TunedToken]> = [
  ['theme.contrast.body', '--mel-ink', '--mel-canvas'],
  ['theme.contrast.muted', '--mel-ink-muted', '--mel-surface'],
  ['theme.contrast.subtle', '--mel-ink-subtle', '--mel-surface'],
  ['theme.contrast.accent', '--mel-accent-ink', '--mel-accent'],
]

export function contrastChecks(palette: ReadonlyMap<string, string>): ContrastCheck[] {
  const out: ContrastCheck[] = []
  for (const [labelKey, front, back] of CHECKED_PAIRS) {
    const a = parseOklch(palette.get(front) ?? '')
    const b = parseOklch(palette.get(back) ?? '')
    if (!a || !b) continue
    /*
     * A wash is measured as if opaque. Its alpha sits over a surface this
     * function does not know, and reporting a flattering number for a
     * translucent layer would be worse than reporting the strict one.
     */
    const ratio = contrastRatio({ ...a, alpha: undefined }, { ...b, alpha: undefined })
    out.push({ labelKey, ratio, grade: gradeContrast(ratio) })
  }
  return out
}

const STORAGE_KEY = 'mel:theme-tuning'

export function readStoredTuning(): ThemeTuning | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ThemeTuning>
    const numbers = [parsed.accentHue, parsed.accentChroma, parsed.surfaceHue, parsed.surfaceTint]
    if (!numbers.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    return parsed as ThemeTuning
  } catch {
    // Absent, denied, or written by a hand that meant well.
    return null
  }
}

function storeTuning(tuning: ThemeTuning | null): void {
  try {
    if (tuning) localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private window: the theme lasts as long as the tab does */
  }
}

/*
 * Live tuning, as a store: the settings dialog opens over the app rather than
 * replacing it, so a change has to reach the screen behind it — and the
 * ThemeProvider has to hear about it too.
 */
let current: ThemeTuning | null | undefined
const listeners = new Set<() => void>()

/** The tuning in force, or null when the shipped palette is wanted. */
export function themeTuning(): ThemeTuning | null {
  if (current === undefined) current = readStoredTuning()
  return current
}

export function setThemeTuning(tuning: ThemeTuning | null): void {
  current = tuning
  storeTuning(tuning)
  for (const fn of listeners) fn()
}

/**
 * Back to the shipped palette, and stop remembering a tuning at all.
 *
 * Forgetting rather than storing today's defaults: "no opinion" must keep
 * following the palette, or a later redesign would silently not reach anyone
 * who had ever opened this screen.
 */
export function resetThemeTuning(): void {
  setThemeTuning(null)
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function useThemeTuning() {
  const tuning = useSyncExternalStore(subscribe, themeTuning, themeTuning)
  const set = useCallback((next: ThemeTuning | null) => setThemeTuning(next), [])
  return { tuning, set, reset: resetThemeTuning }
}

/**
 * The palette as the stylesheet has it, with any overrides of ours lifted.
 *
 * They have to come off first. The tokens are read back through
 * getComputedStyle, and an inline value set by the last call would be
 * returned instead of the stylesheet's — so each pass would retint the
 * previous pass's output and the colour would drift further on every slider
 * move.
 *
 * Reading fresh each time is also what makes the light/dark switch work with
 * no bookkeeping: the two palettes share their hues but not their lightness,
 * and whichever rule is in force answers.
 */
export function readBasePalette(root: HTMLElement): Map<string, string> {
  for (const token of TUNED_TOKENS) root.style.removeProperty(token)
  const computed = getComputedStyle(root)
  const base = new Map<string, string>()
  for (const token of TUNED_TOKENS) {
    const value = computed.getPropertyValue(token).trim()
    if (value) base.set(token, value)
  }
  return base
}

/**
 * Put a tuning on the page, or take the last one off.
 *
 * Overrides go on the root element rather than on `body`, and they have to:
 * `@theme` maps `--color-accent: var(--mel-accent)` at `:root`, and a custom
 * property resolves where it is *declared*, not where it is used. An override
 * further down the tree would be inherited by nothing that matters.
 */
export function applyThemeTuning(root: HTMLElement, tuning: ThemeTuning | null): void {
  const base = readBasePalette(root)
  if (!tuning) return
  for (const [token, value] of deriveOverrides(base, tuning)) {
    root.style.setProperty(token, value)
  }
}

/**
 * The tuning that reproduces the shipped palette, read off the stylesheet.
 *
 * The editor opens on these when nothing is stored, so the sliders start
 * where the design is rather than at an invented midpoint — and so a later
 * change to the palette moves them with it.
 */
export function tuningFromPalette(base: ReadonlyMap<string, string>): ThemeTuning {
  const accent = parseOklch(base.get('--mel-accent') ?? '')
  const surface = parseOklch(base.get('--mel-canvas') ?? '')
  return {
    accentHue: accent?.h ?? 292,
    accentChroma: 1,
    surfaceHue: surface?.h ?? 300,
    surfaceTint: 1,
  }
}
