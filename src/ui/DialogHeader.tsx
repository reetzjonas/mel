import type { ReactNode, Ref } from 'react'

/** The compact, text-action header shared by finite modal sheets. */
export function DialogHeader({
  title,
  closeLabel,
  closeRef,
  onClose,
  action,
}: {
  title: string
  closeLabel: string
  closeRef?: Ref<HTMLButtonElement>
  onClose: () => void
  action?: ReactNode
}) {
  return (
    <header className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
      <button
        type="button"
        ref={closeRef}
        onClick={onClose}
        className="min-w-0 text-left text-sm text-ink-muted hover:text-ink"
      >
        {closeLabel}
      </button>
      <h2 className="min-w-0 text-center text-sm leading-5 font-semibold">{title}</h2>
      <div className="min-w-0">
        {action ?? (
          <span aria-hidden className="invisible text-sm">
            {closeLabel}
          </span>
        )}
      </div>
    </header>
  )
}
