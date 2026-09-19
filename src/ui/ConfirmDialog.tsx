import { useRef } from 'react'
import { DialogHeader } from './DialogHeader'
import { modalPanelClass } from './styles'
import { useMobileViewport, useModal } from './useModal'

/** A deliberate, non-dismissible confirmation for destructive actions. */
export function ConfirmDialog({
  title,
  message,
  cancelLabel,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string
  message: string
  cancelLabel: string
  confirmLabel: string
  onConfirm: () => void
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, initialFocus: cancel, onClose })
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${modalPanelClass} max-w-sm max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 32}px` } : undefined}
      >
        <DialogHeader
          title={title}
          closeLabel={cancelLabel}
          closeRef={cancel}
          onClose={onClose}
          action={
            <button
              type="button"
              onClick={onConfirm}
              className="text-sm font-semibold text-danger hover:text-danger/75"
            >
              {confirmLabel}
            </button>
          }
        />
        <div className="p-5">
          <p className="text-sm">{message}</p>
        </div>
      </div>
    </div>
  )
}
