/**
 * Just enough colour science for the theme editor.
 *
 * Hand-rolled rather than a dependency: this is four matrix multiplications
 * and a gamma curve, all of it specified exactly, and the project already
 * declines CDN fonts and the like for the same reason. It is also the part
 * where being wrong is invisible — a slightly bent conversion still produces
 * plausible colours — so it is pure, and tested against values that can be
 * looked up.
 */

export interface Oklch {
  /** Perceptual lightness, 0–1. */
  l: number
  /** Chroma; 0 is grey, ~0.37 is about as far as sRGB reaches. */
  c: number
  /** Hue in degrees. */
  h: number
  /** Alpha, 0–1. Absent means fully opaque. */
  alpha?: number | undefined
}

/**
 * Reads `oklch(L C H)` and `oklch(L C H / A)`.
 *
 * Only the form this project's stylesheet actually uses. A percentage or a
 * `none` component would parse to NaN, which is why the caller gets null
 * instead of a colour it cannot trust.
 */
export function parseOklch(input: string): Oklch | null {
  const m = /^\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)\s*$/i.exec(
    input,
  )
  if (!m) return null
  const [l, c, h] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const alpha = m[4] === undefined ? undefined : Number(m[4])
  if (![l, c, h].every(Number.isFinite)) return null
  if (alpha !== undefined && !Number.isFinite(alpha)) return null
  return { l, c, h, alpha }
}

/** Back to CSS, rounded to the precision the stylesheet itself uses. */
export function formatOklch({ l, c, h, alpha }: Oklch): string {
  const body = `${round(l, 4)} ${round(c, 4)} ${round(h, 2)}`
  return alpha === undefined ? `oklch(${body})` : `oklch(${body} / ${round(alpha, 3)})`
}

const round = (v: number, places: number) => Number(v.toFixed(places))

/*
 * OKLab → linear sRGB, from Björn Ottosson's definition. The cube roots go
 * back to LMS, then one matrix to linear RGB; gamma encoding is separate
 * because luminance needs the linear values and CSS needs the encoded ones.
 */
function toLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)

  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ]
}

/** Whether every channel lands inside sRGB, within a hair's breadth. */
export function inSrgbGamut(colour: Oklch): boolean {
  const eps = 0.0001
  return toLinearSrgb(colour).every((v) => v >= -eps && v <= 1 + eps)
}

/**
 * The same colour, dulled until the screen can show it.
 *
 * A hue the user picked at full chroma often falls outside sRGB — deep blues
 * reach much further than yellows do. The browser would clip it channel by
 * channel, which shifts the hue; stepping the chroma down instead keeps the
 * hue and gives up only the saturation that was never displayable.
 */
export function clampToSrgb(colour: Oklch): Oklch {
  if (inSrgbGamut(colour)) return colour
  let low = 0
  let high = colour.c
  // Twenty halvings put this well under a rounding step of the output.
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    if (inSrgbGamut({ ...colour, c: mid })) low = mid
    else high = mid
  }
  return { ...colour, c: low }
}

/**
 * WCAG relative luminance.
 *
 * Deliberately measured rather than assumed. Holding OKLCH's `L` steady keeps
 * *perceptual* lightness, which is most of the story — but the WCAG figure is
 * computed from sRGB primaries weighted 0.2126/0.7152/0.0722, so chroma moves
 * it a little too. The editor shows what this returns, not what the structure
 * promises.
 */
export function relativeLuminance(colour: Oklch): number {
  const [r, g, b] = toLinearSrgb(clampToSrgb(colour)).map((v) => Math.min(1, Math.max(0, v))) as [
    number,
    number,
    number,
  ]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (light + 0.05) / (dark + 0.05)
}

export type ContrastGrade = 'AAA' | 'AA' | 'AA-large' | 'fail'

/**
 * What a ratio is good enough for, by WCAG 2.2 §1.4.3 and §1.4.6.
 *
 * 'AA-large' is the honest middle: 3:1 passes for headings and large text but
 * not for the body copy that makes up a mailbox, so it is neither a pass nor
 * a failure without knowing what it is for.
 */
export function gradeContrast(ratio: number): ContrastGrade {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA-large'
  return 'fail'
}
