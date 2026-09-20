import { useRef, useState } from 'react'
import type { CalendarEvent, EventNotification } from '../../domain/calendar'
import { currentLocale, t } from '../../lib/i18n'
import { dismissNotifications } from '../../services/eventNotifications'
import { notificationText } from './notificationText'
import { DialogHeader } from '../../ui/DialogHeader'
import { Icon } from '../../ui/Icon'
import { modalPanelClass, modalScrimClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'

const when = new Intl.DateTimeFormat(currentLocale, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Other people's changes to events we are part of: who accepted, who changed
 * the time, who cancelled.
 *
 * Clicking one opens the event, if it still exists here. Dismissing is an
 * explicit act and reaches the server — see `services/eventNotifications.ts`.
 */
export function NotificationsDialog({
  accountId,
  notifications,
  eventById,
  onOpen,
  onClose,
}: {
  accountId: string
  notifications: EventNotification[]
  eventById: Map<string, CalendarEvent>
  onOpen: (event: CalendarEvent) => void
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, onClose })

  async function dismiss(ids: string[]) {
    setBusy(true)
    setError(null)
    const failure = await dismissNotifications(accountId, ids)
    setBusy(false)
    if (failure) setError(t('cal.notif.failed'))
  }

  return (
    <div
      className={modalScrimClass}
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('cal.notif.title')}
        className={`${modalPanelClass} max-h-[80vh] max-w-md max-sm:max-h-[92dvh] max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 32}px` } : undefined}
      >
        <DialogHeader
          title={t('cal.notif.title')}
          closeLabel={t('cal.close')}
          onClose={onClose}
          action={
            notifications.length > 1 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void dismiss(notifications.map((n) => n.id))}
                className="text-sm font-semibold text-ink-muted hover:text-accent disabled:text-ink-subtle"
              >
                {t('cal.notif.dismissAll')}
              </button>
            ) : undefined
          }
        />
        {error && <p className="px-4 pt-3 text-xs text-danger sm:px-5">{error}</p>}
        {notifications.length === 0 ? (
          <p className="p-5 text-sm text-ink-subtle">{t('cal.notif.empty')}</p>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {notifications.map((n) => {
              const event = n.eventId ? eventById.get(n.eventId) : undefined
              const text = notificationText(n, event)
              const time = n.created ? when.format(new Date(n.created)) : ''
              return (
                <li key={n.id} className="flex items-start gap-2 px-4 py-3 sm:px-5">
                  {event ? (
                    <button
                      type="button"
                      onClick={() => onOpen(event)}
                      className="min-w-0 flex-1 text-left text-sm hover:text-accent"
                    >
                      <span className="block">{text}</span>
                      <span className="block text-xs text-ink-subtle">{time}</span>
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1 text-sm">
                      <span className="block">{text}</span>
                      <span className="block text-xs text-ink-subtle">{time}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t('cal.notif.dismiss')}: ${text}`}
                    onClick={() => void dismiss([n.id])}
                    className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control p-1 text-ink-muted hover:bg-surface-2 hover:text-ink sm:min-h-0 sm:min-w-0"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
