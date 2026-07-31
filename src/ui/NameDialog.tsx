import { useState } from 'react'
import { inputClass, overlayPanelClass, primaryButtonClass } from './styles'

export function NameDialog({
  title,
  initial = '',
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
}: {
  title: string
  initial?: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <form
        className={`animate-rise w-full max-w-xs space-y-3 p-5 ${overlayPanelClass}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onConfirm(value.trim())
        }}
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={inputClass}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-control px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {cancelLabel}
          </button>
          <button type="submit" className={primaryButtonClass}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
