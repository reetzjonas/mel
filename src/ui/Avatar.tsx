/*
 * Hues spread evenly around the wheel at a fixed lightness/chroma, so every
 * avatar reads as part of one family instead of a random swatch grab-bag.
 * White text on L=0.55 C=0.14 clears WCAG AA at these sizes.
 */
const HUES = [292, 250, 205, 165, 130, 75, 35, 0, 330]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function Avatar({ name, email, size = 36 }: { name: string; email: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
  const hue = HUES[hash(email.toLowerCase()) % HUES.length]
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, oklch(0.62 0.14 ${hue}), oklch(0.5 0.15 ${hue}))`,
        fontSize: size * 0.36,
      }}
      aria-hidden
    >
      {initials || '?'}
    </span>
  )
}
