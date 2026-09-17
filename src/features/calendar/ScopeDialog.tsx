import { t } from '../../lib/i18n'
import { overlayPanelClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

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
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal
        className={`animate-rise w-full space-y-4 p-5 sm:max-w-sm ${overlayPanelClass} max-sm:rounded-b-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm">{t(kind === 'delete' ? 'cal.scope.delete' : 'cal.scope.edit')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => onChoose(false)}
            className={primaryButtonClass}
          >
            {t('cal.scope.one')}
          </button>
          <button type="button" onClick={() => onChoose(true)} className={secondaryButtonClass}>
            {t('cal.scope.all')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-control px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {t('cal.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
