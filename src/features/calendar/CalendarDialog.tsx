import { useRef, useState } from 'react'
import type { Calendar } from '../../domain/calendar'
import { t } from '../../lib/i18n'
import { createCalendar, deleteCalendar, updateCalendar } from '../../services/calendars'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DialogHeader } from '../../ui/DialogHeader'
import { inputClass, modalPanelClass, modalScrimClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'
import { CALENDAR_SWATCHES } from './calendarColors'

type Asking = 'delete' | 'deleteWithEvents' | null

/**
 * Create a calendar, or rename, recolour or delete one.
 *
 * Writes go straight to the server (see `services/calendars.ts`), so the dialog
 * stays open and says why when the server refuses.
 */
export function CalendarDialog({
  accountId,
  calendar,
  defaultColor,
  onClose,
}: {
  accountId: string
  /** null → a new calendar. */
  calendar: Calendar | null
  defaultColor: string
  onClose: () => void
}) {
  const [name, setName] = useState(calendar?.name ?? '')
  const [color, setColor] = useState<string | null>(calendar ? calendar.color : defaultColor)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<Asking>(null)
  const panel = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const mobileViewport = useMobileViewport()
  // A confirmation above this dialog owns Escape and Tab while it is open.
  useModal({ panel, initialFocus: input, onClose, enabled: asking === null })

  // The default calendar is where new events go; without one there is nowhere to put them.
  const canDelete = calendar !== null && calendar.mayDelete && !calendar.isDefault
  const changed = calendar === null || name.trim() !== calendar.name || color !== calendar.color

  async function save() {
    const trimmed = name.trim()
    if (!trimmed || busy || !changed) return
    setBusy(true)
    setError(null)
    const failure = calendar
      ? await updateCalendar(accountId, calendar.id, {
          ...(trimmed !== calendar.name ? { name: trimmed } : {}),
          ...(color !== calendar.color ? { color } : {}),
        })
      : await createCalendar(accountId, trimmed, color)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }

  async function remove(withEvents: boolean) {
    if (!calendar) return
    setAsking(null)
    setBusy(true)
    setError(null)
    const r = await deleteCalendar(accountId, calendar.id, { withEvents })
    setBusy(false)
    if (r.ok) return onClose()
    // Not empty: that is a question, not an error.
    if (r.blocker === 'hasEvents') return setAsking('deleteWithEvents')
    setError(r.message ?? t('cal.calendar.deleteFailed'))
  }

  return (
    <div
      className={modalScrimClass}
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <form
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={calendar ? t('cal.calendar.edit') : t('cal.calendar.new')}
        className={`${modalPanelClass} max-w-sm max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 32}px` } : undefined}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <DialogHeader
          title={calendar ? t('cal.calendar.edit') : t('cal.calendar.new')}
          closeLabel={t('cal.cancel')}
          onClose={onClose}
          action={
            <button
              type="submit"
              disabled={!name.trim() || busy || !changed}
              className="text-sm font-semibold text-ink-muted hover:text-accent disabled:text-ink-subtle"
            >
              {t('cal.save')}
            </button>
          }
        />
        <div className="space-y-4 overflow-y-auto p-4 sm:p-5">
          <label className="block space-y-1">
            <span className="text-xs text-ink-muted">{t('cal.calendar.name')}</span>
            <input
              ref={input}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <fieldset className="space-y-1">
            <legend className="text-xs text-ink-muted">{t('cal.calendar.color')}</legend>
            <div className="flex flex-wrap gap-2">
              {CALENDAR_SWATCHES.map((c) => (
                <label
                  key={c}
                  className="flex h-11 w-11 cursor-pointer items-center justify-center sm:h-7 sm:w-7"
                >
                  <input
                    type="radio"
                    name="calendar-color"
                    value={c}
                    checked={color === c}
                    onChange={() => setColor(c)}
                    aria-label={c}
                    className="peer sr-only"
                  />
                  <span
                    className="block h-7 w-7 rounded-full ring-offset-2 ring-offset-raised transition-shadow peer-checked:ring-2 peer-focus-visible:ring-2 peer-focus-visible:ring-accent"
                    style={{ backgroundColor: c, ['--tw-ring-color' as string]: c }}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          {error && <p className="text-xs text-danger">{error}</p>}

          {calendar && (
            <div className="space-y-1">
              <button
                type="button"
                disabled={!canDelete || busy}
                onClick={() => setAsking('delete')}
                className="inline-flex min-h-11 items-center text-sm text-danger hover:underline disabled:text-ink-subtle disabled:no-underline sm:min-h-0"
              >
                {t('cal.calendar.delete')}
              </button>
              {calendar.isDefault && (
                <p className="text-xs text-ink-subtle">{t('cal.calendar.deleteDefault')}</p>
              )}
            </div>
          )}
        </div>
      </form>

      {asking && calendar && (
        <ConfirmDialog
          title={t('cal.calendar.delete')}
          message={
            asking === 'delete'
              ? t('cal.calendar.deleteMessage')
              : t('cal.calendar.deleteWithEventsMessage')
          }
          cancelLabel={t('cal.cancel')}
          confirmLabel={t('cal.calendar.delete')}
          onConfirm={() => void remove(asking === 'deleteWithEvents')}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  )
}
