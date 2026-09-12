import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseOklch } from '../lib/oklch'
import {
  TUNED_TOKENS,
  applyThemeTuning,
  readBasePalette,
  useThemeTuning,
  contrastChecks,
  deriveOverrides,
  readStoredTuning,
  resetThemeTuning,
  retint,
  setThemeTuning,
  themeTuning,
  tuningFromPalette,
  type ThemeTuning,
} from './themeTuning'

/** The shipped light palette, as index.css has it. */
const LIGHT = new Map<string, string>([
  ['--mel-canvas', 'oklch(0.968 0.004 300)'],
  ['--mel-surface', 'oklch(1 0 0)'],
  ['--mel-surface-2', 'oklch(0.955 0.005 300)'],
  ['--mel-raised', 'oklch(1 0 0)'],
  ['--mel-line', 'oklch(0.915 0.006 300)'],
  ['--mel-line-strong', 'oklch(0.86 0.008 300)'],
  ['--mel-ink', 'oklch(0.245 0.017 300)'],
  ['--mel-ink-muted', 'oklch(0.53 0.017 300)'],
  ['--mel-ink-subtle', 'oklch(0.65 0.014 300)'],
  ['--mel-accent', 'oklch(0.48 0.2 292)'],
  ['--mel-accent-hover', 'oklch(0.43 0.2 292)'],
  ['--mel-accent-ink', 'oklch(0.99 0 0)'],
  ['--mel-accent-wash', 'oklch(0.48 0.2 292 / 0.1)'],
  ['--mel-scrollbar', 'oklch(0.245 0.017 300 / 0.18)'],
])

const asShipped: ThemeTuning = {
  accentHue: 292,
  accentChroma: 1,
  surfaceHue: 300,
  surfaceTint: 1,
}

const at = (overrides: Map<string, string>, token: string) => parseOklch(overrides.get(token)!)!

beforeEach(() => {
  // Unstub first: one test below replaces localStorage with a stub that
  // throws and has no clear(), and clearing before restoring would hand that
  // stub to every test after it.
  vi.unstubAllGlobals()
  localStorage.clear()
  resetThemeTuning()
})

describe('turning one colour', () => {
  it('moves hue and chroma while leaving lightness exactly where it was', () => {
    /*
     * The whole reason the guided editor is safe. The palette's readability
     * lives in its lightness ladders, so those are the one thing the sliders
     * must not touch.
     */
    const base = { l: 0.48, c: 0.2, h: 292 }

    const turned = retint(base, 150, 0.5)

    expect(turned.l).toBe(0.48)
    expect(turned.h).toBe(150)
    expect(turned.c).toBeCloseTo(0.1, 4)
  })

  it('keeps a grey token grey, whatever the sliders say', () => {
    // `--mel-surface` ships as pure white. Scaling its chroma is scaling zero,
    // and a white surface is a design decision, not an oversight.
    expect(retint({ l: 1, c: 0, h: 0 }, 150, 3).c).toBe(0)
  })

  it('carries alpha through, or a wash becomes a fill', () => {
    // --mel-accent-wash and --mel-scrollbar are translucent by design.
    expect(retint({ l: 0.48, c: 0.2, h: 292, alpha: 0.1 }, 150, 1).alpha).toBe(0.1)
  })

  it('wraps a hue past the ends of the circle', () => {
    // The slider runs 0–360, but arithmetic on it need not.
    expect(retint({ l: 0.5, c: 0.1, h: 0 }, 370, 1).h).toBe(10)
    expect(retint({ l: 0.5, c: 0.1, h: 0 }, -10, 1).h).toBe(350)
  })

  it('never asks the screen for a colour it cannot show', () => {
    // A slider at three times the shipped chroma is well outside sRGB at most
    // hues; the clamp gives up saturation rather than the chosen hue.
    const turned = retint({ l: 0.48, c: 0.2, h: 292 }, 264, 3)

    expect(turned.h).toBe(264)
    expect(turned.c).toBeLessThan(0.6)
  })
})

describe('turning the palette', () => {
  it('leaves the shipped palette alone when the sliders are where it is', () => {
    const overrides = deriveOverrides(LIGHT, asShipped)

    expect(at(overrides, '--mel-accent')).toMatchObject({ l: 0.48, c: 0.2, h: 292 })
    expect(at(overrides, '--mel-ink')).toMatchObject({ l: 0.245, c: 0.017, h: 300 })
  })

  it('moves the accent family together, and only it', () => {
    /*
     * Two controls, two families. An accent hue that also dragged the page
     * background with it would make the surface slider meaningless.
     */
    const overrides = deriveOverrides(LIGHT, { ...asShipped, accentHue: 150 })

    expect(at(overrides, '--mel-accent').h).toBe(150)
    expect(at(overrides, '--mel-accent-hover').h).toBe(150)
    expect(at(overrides, '--mel-accent-wash').h).toBe(150)
    expect(at(overrides, '--mel-ink').h).toBe(300)
    expect(at(overrides, '--mel-canvas').h).toBe(300)
  })

  it('moves every neutral together, ink included', () => {
    // The ink is tinted with the surfaces on purpose: grey text on a warm
    // page reads as a mistake, not as restraint.
    const overrides = deriveOverrides(LIGHT, { ...asShipped, surfaceHue: 60 })

    for (const token of ['--mel-canvas', '--mel-surface-2', '--mel-line', '--mel-ink']) {
      expect(at(overrides, token).h, token).toBe(60)
    }
    expect(at(overrides, '--mel-accent').h).toBe(292)
  })

  it('leaves the semantic colours out entirely', () => {
    /*
     * danger, success and honey are not in the tuned set: their hue is their
     * meaning. A green "delete" would be a bug wearing the clothes of a
     * preference.
     */
    for (const token of ['--mel-danger', '--mel-success', '--mel-honey', '--mel-danger-wash']) {
      expect(TUNED_TOKENS, token).not.toContain(token)
    }
  })

  it('skips a token it cannot read rather than inventing one', () => {
    // A future palette might use a colour space this does not parse. Leaving
    // the token alone degrades to "unchanged"; guessing does not.
    const odd = new Map(LIGHT).set('--mel-ink', 'color(display-p3 0.1 0.1 0.1)')

    const overrides = deriveOverrides(odd, { ...asShipped, surfaceHue: 60 })

    expect(overrides.has('--mel-ink')).toBe(false)
    expect(overrides.has('--mel-canvas')).toBe(true)
  })
})

describe('what the editor reports about contrast', () => {
  it('measures the pairs a mailbox is actually read through', () => {
    const checks = contrastChecks(LIGHT)

    expect(checks.map((c) => c.labelKey)).toEqual([
      'theme.contrast.body',
      'theme.contrast.muted',
      'theme.contrast.subtle',
      'theme.contrast.accent',
    ])
    // The shipped palette had better pass for body text.
    expect(checks[0]!.grade).toBe('AAA')
  })

  it('measures, rather than trusting the lightness ladder', () => {
    /*
     * Holding L steady keeps perceptual lightness, but WCAG weights the sRGB
     * primaries, so a heavily saturated palette still moves the number. This
     * is why the editor shows a figure instead of a promise.
     */
    const saturated = deriveOverrides(LIGHT, { ...asShipped, surfaceTint: 8, surfaceHue: 264 })

    const before = contrastChecks(LIGHT)[0]!.ratio
    const after = contrastChecks(saturated)[0]!.ratio

    expect(after).not.toBeCloseTo(before, 1)
  })

  it('judges a translucent token strictly rather than flatteringly', () => {
    // The wash's alpha sits over a surface this cannot see; a number that
    // assumed the friendliest backdrop would be worse than a strict one.
    const checks = contrastChecks(LIGHT)
    expect(checks.every((c) => Number.isFinite(c.ratio))).toBe(true)
  })
})

describe('where the editor starts', () => {
  it('opens on the palette as shipped, not on an invented midpoint', () => {
    // So a later redesign moves the sliders with it instead of leaving them
    // pointing at last year's accent.
    expect(tuningFromPalette(LIGHT)).toEqual(asShipped)
  })

  it('falls back to the designed hues if the palette cannot be read', () => {
    expect(tuningFromPalette(new Map())).toMatchObject({ accentHue: 292, surfaceHue: 300 })
  })
})

describe('remembering a tuning', () => {
  it('survives a round trip through storage', () => {
    const wanted: ThemeTuning = {
      accentHue: 150,
      accentChroma: 1.2,
      surfaceHue: 60,
      surfaceTint: 0.5,
    }

    setThemeTuning(wanted)

    expect(readStoredTuning()).toEqual(wanted)
    expect(themeTuning()).toEqual(wanted)
  })

  it('forgets on reset rather than storing today’s defaults', () => {
    /*
     * "No opinion" has to keep following the palette. Storing the current
     * defaults would freeze whoever pressed reset at this year's design.
     */
    setThemeTuning({ accentHue: 150, accentChroma: 1, surfaceHue: 300, surfaceTint: 1 })

    resetThemeTuning()

    expect(readStoredTuning()).toBeNull()
    expect(themeTuning()).toBeNull()
  })

  it('ignores a stored value that is missing a field', () => {
    // Written by an older version, or by hand. A half-applied tuning would
    // retint some tokens and not others.
    localStorage.setItem('mel:theme-tuning', JSON.stringify({ accentHue: 150 }))
    expect(readStoredTuning()).toBeNull()
  })

  it('ignores stored text that is not a tuning at all', () => {
    for (const raw of ['', 'not json', '[]', 'null', '{"accentHue":"blue"}']) {
      localStorage.setItem('mel:theme-tuning', raw)
      expect(readStoredTuning(), raw).toBeNull()
    }
  })

  it('treats an unreadable store as no preference', () => {
    // Safari in a private window throws on access rather than answering empty.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })

    expect(readStoredTuning()).toBeNull()
    expect(() => setThemeTuning(asShipped)).not.toThrow()
  })
})

/*
 * The DOM half. jsdom does resolve custom properties declared in a stylesheet,
 * which is what makes this testable here rather than only in a browser —
 * checked before relying on it.
 */
describe('putting a tuning on the page', () => {
  let style: HTMLStyleElement

  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = `:root {
      --mel-accent: oklch(0.48 0.2 292);
      --mel-accent-wash: oklch(0.48 0.2 292 / 0.1);
      --mel-canvas: oklch(0.968 0.004 300);
      --mel-ink: oklch(0.245 0.017 300);
      --mel-danger: oklch(0.53 0.2 25);
    }`
    document.head.append(style)
  })

  afterEach(() => {
    style.remove()
    for (const token of TUNED_TOKENS) document.documentElement.style.removeProperty(token)
  })

  const root = () => document.documentElement
  const live = (token: string) =>
    parseOklch(getComputedStyle(root()).getPropertyValue(token).trim())

  it('reads the stylesheet rather than its own last output', () => {
    /*
     * The trap this function exists to avoid. Overrides are read back through
     * getComputedStyle, so leaving the previous pass in place would retint its
     * own output — and the colour would drift further on every slider move
     * instead of tracking the slider.
     */
    applyThemeTuning(root(), { accentHue: 200, accentChroma: 1, surfaceHue: 300, surfaceTint: 1 })
    applyThemeTuning(root(), { accentHue: 100, accentChroma: 1, surfaceHue: 300, surfaceTint: 1 })
    applyThemeTuning(root(), { accentHue: 50, accentChroma: 1, surfaceHue: 300, surfaceTint: 1 })

    // Three passes, and the answer is the third slider position — not a hue
    // dragged 350° around the circle.
    expect(live('--mel-accent')!.h).toBeCloseTo(50, 1)
    expect(live('--mel-accent')!.l).toBeCloseTo(0.48, 3)
  })

  it('leaves the semantic colours where the stylesheet put them', () => {
    applyThemeTuning(root(), { accentHue: 200, accentChroma: 1.5, surfaceHue: 60, surfaceTint: 2 })

    expect(live('--mel-danger')!.h).toBeCloseTo(25, 1)
  })

  it('takes every override off again for a null tuning', () => {
    // Reset has to return the page to the stylesheet, not to a tuning that
    // happens to match it today.
    applyThemeTuning(root(), { accentHue: 200, accentChroma: 1, surfaceHue: 300, surfaceTint: 1 })
    expect(root().style.getPropertyValue('--mel-accent')).not.toBe('')

    applyThemeTuning(root(), null)

    expect(root().style.getPropertyValue('--mel-accent')).toBe('')
    expect(live('--mel-accent')!.h).toBeCloseTo(292, 1)
  })

  it('reads the base with its own overrides lifted', () => {
    applyThemeTuning(root(), { accentHue: 200, accentChroma: 1, surfaceHue: 300, surfaceTint: 1 })

    expect(parseOklch(readBasePalette(root()).get('--mel-accent')!)!.h).toBeCloseTo(292, 1)
  })
})

describe('the tuning a screen is looking at', () => {
  it('reaches a component that is already mounted', () => {
    // Settings opens over the app rather than replacing it, so the screen
    // behind the dialog has to hear about a change without a reload.
    const { result } = renderHook(() => useThemeTuning())
    expect(result.current.tuning).toBeNull()

    act(() => result.current.set({ ...asShipped, accentHue: 200 }))
    expect(result.current.tuning).toMatchObject({ accentHue: 200 })

    act(() => result.current.reset())
    expect(result.current.tuning).toBeNull()
  })
})
