import { useRef, useState } from 'react'
import { inputClass, modalPanelClass } from './styles'
import { useMobileViewport, useModal } from './useModal'
import { DialogHeader } from './DialogHeader'

export function NameDialog({
  title,
  initial = '',
  inputType = 'text',
  trimValue = true,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
}: {
  title: string
  initial?: string
  inputType?: 'text' | 'url' | 'password'
  trimValue?: boolean
  confirmLabel: string
  cancelLabel: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const panel = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, initialFocus: input, onClose })
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <form
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${modalPanelClass} max-w-xs max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 32}px` } : undefined}
        onSubmit={(e) => {
          e.preventDefault()
          const confirmed = trimValue ? value.trim() : value
          if (confirmed) onConfirm(confirmed)
        }}
      >
        <DialogHeader
          title={title}
          closeLabel={cancelLabel}
          onClose={onClose}
          action={
            <button
              type="submit"
              className="text-sm font-semibold text-ink-muted hover:text-accent"
            >
              {confirmLabel}
            </button>
          }
        />
        <div className="p-5">
          <input
            autoFocus
            ref={input}
            type={inputType}
            aria-label={title}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={inputClass}
          />
        </div>
      </form>
    </div>
  )
}
