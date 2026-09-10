import { useEffect, useRef, useState } from 'react'
import { suggestRecipients, type Suggestion } from '../../services/contacts'

/**
 * Comma-separated recipient input with contact autocomplete on the segment
 * currently being typed.
 */
export function RecipientInput({
  accountId,
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
}: {
  accountId: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  className: string
  autoFocus?: boolean
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0)
  const wrapper = useRef<HTMLDivElement>(null)

  const currentSegment = value.split(',').pop()?.trim() ?? ''

  useEffect(() => {
    let alive = true
    if (currentSegment.length < 2) {
      setSuggestions([])
      return
    }
    void suggestRecipients(accountId, currentSegment).then((s) => {
      if (!alive) return
      // Hide once the typed segment is already a complete suggested address.
      setSuggestions(s.filter((x) => x.email.toLowerCase() !== currentSegment.toLowerCase()))
      setActive(0)
    })
    return () => {
      alive = false
    }
  }, [accountId, currentSegment])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setSuggestions([])
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  function pick(s: Suggestion) {
    const parts = value.split(',')
    parts[parts.length - 1] = ` ${s.email}`
    onChange(parts.join(',').replace(/^ /, '') + ', ')
    setSuggestions([])
  }

  return (
    <div ref={wrapper} className="relative">
      <input
        className={className}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        // The app already offers its own suggestions (suggestRecipients,
        // below); the browser's native autofill runs independently of that
        // and surfaces whatever it has, unstyled and occasionally raw — an
        // OS contact synced from Exchange shows up as its literal legacy DN
        // (`/o=.../ou=.../cn=...`) rather than an address. Two suggestion
        // lists stacked, one of them broken-looking, is worse than one.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!suggestions.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, suggestions.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            const s = suggestions[active]
            if (s) pick(s)
          } else if (e.key === 'Escape') {
            setSuggestions([])
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul className="absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          {suggestions.map((s, i) => (
            <li key={`${s.email}-${i}`}>
              <button
                type="button"
                data-active={i === active || undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 data-active:bg-surface-2"
              >
                {/*
                 * Both `min-w-0`: a flex child's default `min-width: auto`
                 * refuses to shrink below its own content, so `truncate`
                 * silently does nothing without it — a long name wrapped onto
                 * a second line instead of eliding, and a long address just
                 * pushed the row wider rather than cutting off.
                 */}
                <span className="min-w-0 shrink truncate font-medium">{s.name || s.email}</span>
                {s.name && (
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{s.email}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
