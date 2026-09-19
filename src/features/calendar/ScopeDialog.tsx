import { useRef } from 'react'
import { t } from '../../lib/i18n'
import { modalPanelClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'
import { DialogHeader } from '../../ui/DialogHeader'

/**
 * "This one, or all of them?" — asked once an edit to a repeating event is
 * already worked out.
 *
 * Both answers are offered as buttons rather than one being the default: a
 * series moved when only today's meeting shifted is a mess to undo by hand,
 * and so is the reverse. Cancelling leaves the event exactly as it was, which
 * is why the question comes *after* the drag rather than blocking it.
 */
export function ScopeDialog({
  kind,
  onChoose,
  onClose,
}: {
  kind: 'edit' | 'delete'
  onChoose: (all: boolean) => void
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<HTMLButtonElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, initialFocus, onClose })
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-label={t(kind === 'delete' ? 'cal.delete' : 'cal.editEvent')}
        className={`${modalPanelClass} sm:max-w-sm max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 16}px` } : undefined}
      >
        <DialogHeader
          title={t(kind === 'delete' ? 'cal.delete' : 'cal.editEvent')}
          closeLabel={t('cal.cancel')}
          onClose={onClose}
        />
        <div className="space-y-4 p-5">
          <p className="text-sm">{t(kind === 'delete' ? 'cal.scope.delete' : 'cal.scope.edit')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              ref={initialFocus}
              onClick={() => onChoose(false)}
              className={primaryButtonClass}
            >
              {t('cal.scope.one')}
            </button>
            <button type="button" onClick={() => onChoose(true)} className={secondaryButtonClass}>
              {t('cal.scope.all')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
