const COLORS = [
  '#2d5bd1',
  '#7c3aed',
  '#0e9488',
  '#c2560f',
  '#b91c62',
  '#4d7c0f',
  '#0369a1',
  '#a16207',
]

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
  const color = COLORS[hash(email.toLowerCase()) % COLORS.length]
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-medium text-white select-none"
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
      aria-hidden
    >
      {initials || '?'}
    </span>
  )
}
