import { useState } from 'react'

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <form
        className="w-full max-w-xs space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-xl"
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
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
