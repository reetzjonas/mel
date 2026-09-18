import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

/**
 * The search box chrome shared by Mail and Contacts (generalized from
 * `mail.$mailboxId.tsx` and `contacts.tsx`, which had it down to the same
 * Tailwind string) — an icon, an input, and a clear button once there is
 * something to clear.
 *
 * Filtering itself stays with the caller: the data and the query semantics
 * differ too much to share (Mail's is a server-side JMAP filter round-trip
 * on Enter, Contacts' is a client-side substring filter on every
 * keystroke), so `onSubmit` is optional and `onChange` is the only thing
 * every caller wires up.
 */
export function SearchInput({
  id,
  value,
  onChange,
  placeholder,
  onSubmit,
  clearLabel,
  className,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Enter (and Escape, to clear) commit the query — omit to filter as you type instead. */
  onSubmit?: (value: string) => void
  /** Shown once `value` is non-empty; omit to never show a clear button. */
  clearLabel?: string
  className?: string
}) {
  return (
    <div className={`relative min-w-0 flex-1 ${className ?? ''}`}>
      <Icon
        name="search"
        size={14}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-subtle"
      />
      <input
        id={id}
        className={`w-full rounded-control bg-surface-2 py-2 pl-8 text-[13px] outline-none transition-shadow placeholder:text-ink-subtle focus:ring-2 focus:ring-accent ${
          clearLabel ? 'pr-7' : 'pr-3'
        }`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={
          onSubmit
            ? (e) => {
                if (e.key === 'Enter') onSubmit(value.trim())
                if (e.key === 'Escape') onSubmit('')
              }
            : undefined
        }
      />
      {clearLabel && value && (
        <Tooltip label={clearLabel}>
          <button
            type="button"
            aria-label={clearLabel}
            onClick={() => (onSubmit ? onSubmit('') : onChange(''))}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-subtle transition-colors hover:text-ink"
          >
            <Icon name="close" size={13} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
