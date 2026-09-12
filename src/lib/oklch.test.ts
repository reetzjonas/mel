import { describe, expect, it } from 'vitest'
import {
  clampToSrgb,
  contrastRatio,
  formatOklch,
  gradeContrast,
  inSrgbGamut,
  parseOklch,
  relativeLuminance,
} from './oklch'

/*
 * Checked against values that can be looked up rather than against this
 * module's own output: a conversion that is slightly wrong still produces
 * plausible colours, so a snapshot of itself would prove nothing.
 */

const white = { l: 1, c: 0, h: 0 }
const black = { l: 0, c: 0, h: 0 }
/** sRGB #ff0000, per the usual conversions. */
const red = { l: 0.6279, c: 0.2577, h: 29.23 }

describe('reading a colour out of the stylesheet', () => {
  it('reads the two forms the stylesheet uses', () => {
    expect(parseOklch('oklch(0.48 0.2 292)')).toEqual({ l: 0.48, c: 0.2, h: 292, alpha: undefined })
    expect(parseOklch('oklch(0.53 0.2 25 / 0.1)')).toEqual({ l: 0.53, c: 0.2, h: 25, alpha: 0.1 })
  })

  it('tolerates the whitespace a computed value comes back with', () => {
    // getPropertyValue keeps whatever the author wrote, leading space included.
    expect(parseOklch('  oklch( 0.48  0.2  292 )  ')).toMatchObject({ l: 0.48 })
  })

  it('reads the form the *built* stylesheet uses, not only the authored one', () => {
    /*
     * The one that got away. The source says `oklch(0.48 0.2 292)`, and this
     * parser used to reject percentages with a comment claiming the stylesheet
     * did not use them — true of the source, false of what ships: the minifier
     * rewrites lightness as a percentage and drops leading zeros.
     *
     *   authored:  oklch(0.48 0.2 292)
     *   built:     oklch(48% .2 292)
     *
     * So the theme editor found no colours at all in a production build, and
     * the unit tests were green throughout. The e2e suite runs against the
     * built image and caught it; these are the exact strings from dist/.
     */
    expect(parseOklch('oklch(48% .2 292)')).toMatchObject({ l: 0.48, c: 0.2, h: 292 })
    expect(parseOklch('oklch(96.8% .004 300)')).toMatchObject({ l: 0.968, c: 0.004, h: 300 })
    expect(parseOklch('oklch(24.5% .017 300/.18)')).toMatchObject({ l: 0.245, alpha: 0.18 })
  })

  it('scales a percentage by that component’s own range', () => {
    // 100% is lightness 1 but chroma 0.4, per the CSS colour spec — treating
    // them alike would make every tinted token wildly oversaturated.
    expect(parseOklch('oklch(50% 50% 200)')).toMatchObject({ l: 0.5, c: 0.2 })
    expect(parseOklch('oklch(0.5 0.2 200 / 50%)')).toMatchObject({ alpha: 0.5 })
  })

  it('answers null for anything it cannot be sure of', () => {
    /*
     * `none`, colour functions and empty strings all reach here eventually — a
     * custom property is whatever someone typed. Null lets the caller leave
     * the token alone instead of writing a guess into the page.
     */
    for (const input of ['', 'red', '#ff0000', 'oklch(none 0.2 292)', 'oklch(0.5 0.2)']) {
      expect(parseOklch(input), input).toBeNull()
    }
  })

  it('refuses a percentage where one makes no sense', () => {
    // Hue is an angle; "50%" of a circle is not a thing CSS defines.
    expect(parseOklch('oklch(0.5 0.2 50%)')).toBeNull()
  })

  it('round-trips through the formatter', () => {
    const value = 'oklch(0.48 0.2 292)'
    expect(formatOklch(parseOklch(value)!)).toBe(value)
    expect(formatOklch(parseOklch('oklch(0.53 0.2 25 / 0.1)')!)).toBe('oklch(0.53 0.2 25 / 0.1)')
  })

  it('keeps alpha out of the output when there was none', () => {
    // `oklch(L C H / 1)` is the same colour but not the same text, and these
    // values are written back into the stylesheet.
    expect(formatOklch({ l: 0.5, c: 0.1, h: 200 })).toBe('oklch(0.5 0.1 200)')
  })
})

describe('luminance and contrast', () => {
  it('puts white and black where WCAG does', () => {
    expect(relativeLuminance(white)).toBeCloseTo(1, 3)
    expect(relativeLuminance(black)).toBeCloseTo(0, 3)
    // The maximum the scale can produce, and a number worth recognising.
    expect(contrastRatio(white, black)).toBeCloseTo(21, 1)
  })

  it('matches the known luminance of pure red', () => {
    // 0.2126 is the sRGB red coefficient: a fully saturated red is exactly
    // that bright, which is why red text on white struggles.
    expect(relativeLuminance(red)).toBeCloseTo(0.2126, 2)
  })

  it('does not care which way round the pair is given', () => {
    expect(contrastRatio(white, black)).toBeCloseTo(contrastRatio(black, white), 6)
  })

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio(red, red)).toBeCloseTo(1, 6)
  })

  it('notices that chroma moves the figure, not only lightness', () => {
    /*
     * The reason the editor measures instead of promising. Holding OKLCH's L
     * steady keeps perceptual lightness, but WCAG weights the sRGB primaries,
     * so saturating a colour at constant L still shifts its luminance.
     */
    const grey = { l: 0.6279, c: 0, h: 29.23 }

    expect(relativeLuminance(grey)).not.toBeCloseTo(relativeLuminance(red), 2)
  })
})

describe('colours the screen cannot show', () => {
  it('knows what fits', () => {
    expect(inSrgbGamut(white)).toBe(true)
    expect(inSrgbGamut({ l: 0.5, c: 0.001, h: 200 })).toBe(true)
    // Far beyond any real display at this lightness.
    expect(inSrgbGamut({ l: 0.5, c: 0.5, h: 200 })).toBe(false)
  })

  it('gives up saturation rather than hue', () => {
    /*
     * Left to the browser, an out-of-gamut colour is clipped per channel,
     * which drags the hue somewhere else — a blue the user picked comes back
     * purple. Stepping the chroma down keeps the hue they chose and loses
     * only what was never displayable.
     */
    const wanted = { l: 0.5, c: 0.5, h: 264 }
    const shown = clampToSrgb(wanted)

    expect(shown.h).toBe(wanted.h)
    expect(shown.l).toBe(wanted.l)
    expect(shown.c).toBeLessThan(wanted.c)
    expect(inSrgbGamut(shown)).toBe(true)
  })

  it('leaves a colour that already fits exactly as it was', () => {
    const fine = { l: 0.48, c: 0.2, h: 292 }
    expect(clampToSrgb(fine)).toBe(fine)
  })

  it('reaches further at some hues than others, and swaps them with lightness', () => {
    /*
     * Why a single "maximum chroma" would be wrong, and why the editor lets
     * the slider ask for more than the screen can show and then clamps.
     *
     * Measured, and the ordering genuinely flips: a dark blue reaches chroma
     * 0.206 where a dark yellow manages 0.072, while a pale yellow reaches
     * 0.128 against a pale blue's 0.048. Blue is intrinsically dark and
     * yellow intrinsically light, so each runs out at the far end.
     */
    const reach = (l: number, h: number) => clampToSrgb({ l, c: 0.4, h }).c

    expect(reach(0.35, 264)).toBeGreaterThan(reach(0.35, 90))
    expect(reach(0.9, 90)).toBeGreaterThan(reach(0.9, 264))
  })
})

describe('what a ratio is good enough for', () => {
  it('grades by the WCAG thresholds', () => {
    expect(gradeContrast(21)).toBe('AAA')
    expect(gradeContrast(7)).toBe('AAA')
    expect(gradeContrast(6.9)).toBe('AA')
    expect(gradeContrast(4.5)).toBe('AA')
    expect(gradeContrast(4.4)).toBe('AA-large')
    expect(gradeContrast(3)).toBe('AA-large')
    expect(gradeContrast(2.9)).toBe('fail')
  })

  it('keeps "large text only" as its own answer', () => {
    /*
     * 3:1 passes for headings and not for body copy, and a mailbox is body
     * copy. Rounding it up to a pass would bless a palette nobody can read
     * their mail in; rounding it down to a failure would condemn a heading
     * colour that is fine.
     */
    expect(gradeContrast(3.5)).toBe('AA-large')
  })
})
