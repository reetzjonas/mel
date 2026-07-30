import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useUi } from '../store'
import type { CalendarEvent, Occurrence } from '../../domain/calendar'
import { EventDialog } from '../../features/calendar/EventDialog'
import { useCalendars, useEvents } from '../../features/calendar/hooks'
import { useAccounts } from '../../features/mail/hooks'
import { t, currentLocale } from '../../lib/i18n'
import { expandAll } from '../../lib/recurrence'
import { createEvent, deleteEvent, updateEvent } from '../../services/calendar'
import { Icon } from '../../ui/Icon'

export const Route = createFileRoute('/calendar')({
  component: CalendarApp,
})

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

function monthGrid(anchor: Date): Date[] {
  // 6 weeks starting on the Monday on/before the 1st.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = new Date(first)
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const timeFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })
const monthFmt = new Intl.DateTimeFormat(currentLocale, { month: 'long', year: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat(currentLocale, { weekday: 'short' })
const agendaFmt = new Intl.DateTimeFormat(currentLocale, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

interface DialogState {
  event: CalendarEvent
  isNew: boolean
}

function CalendarApp() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const calendars = useCalendars(account?.id)
  const events = useEvents(account?.id)
  const { showSnackbar } = useUi()
  const [anchor, setAnchor] = useState(() => new Date())
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const grid = useMemo(() => monthGrid(anchor), [anchor])
  const byDay = useMemo(() => {
    if (!events?.length) return new Map<string, Occurrence[]>()
    const from = grid[0]!
    const to = new Date(grid[41]!)
    to.setDate(to.getDate() + 1)
    const map = new Map<string, Occurrence[]>()
    for (const occ of expandAll(events, from, to, VIEWER_ZONE)) {
      const key = dayKey(occ.start)
      const list = map.get(key) ?? []
      list.push(occ)
      map.set(key, list)
    }
    return map
  }, [events, grid])

  if (!account?.capabilities.calendars) {
    return (
      <div className="flex h-full items-center justify-center text-ink-muted">
        {t('app.comingSoon.calendar')}
      </div>
    )
  }

  const eventById = new Map((events ?? []).map((e) => [e.id, e]))
  const defaultCalendarId =
    calendars?.find((c) => c.isDefault)?.id ?? calendars?.[0]?.id ?? null

  function openNew(day: Date) {
    if (!defaultCalendarId) return
    setDialog({
      isNew: true,
      event: {
        id: '',
        calendarIds: { [defaultCalendarId]: true },
        uid: '',
        title: '',
        description: '',
        location: '',
        start: `${dayKey(day)}T10:00:00`,
        timeZone: VIEWER_ZONE,
        duration: 'PT1H',
        showWithoutTime: false,
        status: 'confirmed',
        recurrenceRule: null,
      },
    })
  }

  function onDialogSave(e: CalendarEvent) {
    setDialog(null)
    if (dialog?.isNew) {
      const { id: _id, ...rest } = e
      void createEvent(account!.id, rest)
    } else {
      void updateEvent(account!.id, e)
    }
  }

  const today = dayKey(new Date())
  const weekdays = grid.slice(0, 7).map((d) => weekdayFmt.format(d))

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <button
          type="button"
          onClick={() => setAnchor(new Date())}
          className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-2"
        >
          {t('cal.today')}
        </button>
        <button
          type="button"
          aria-label="previous month"
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
          className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2"
        >
          <Icon name="back" size={15} />
        </button>
        <button
          type="button"
          aria-label="next month"
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
          className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2"
        >
          <Icon name="forward" size={15} />
        </button>
        <h1 className="text-base font-semibold capitalize">{monthFmt.format(anchor)}</h1>
        <button
          type="button"
          onClick={() => openNew(new Date())}
          className="ml-auto flex items-center gap-2 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-accent-ink"
        >
          <Icon name="compose" size={14} />
          <span className="hidden sm:inline">{t('cal.newEvent')}</span>
        </button>
      </header>

      {/* Desktop: month grid */}
      <div className="hidden min-h-0 flex-1 flex-col sm:flex">
        <div className="grid grid-cols-7 border-b border-line bg-surface text-center text-xs font-medium text-ink-muted">
          {weekdays.map((w) => (
            <div key={w} className="py-1">
              {w}
            </div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
          {grid.map((day) => {
            const key = dayKey(day)
            const occs = byDay.get(key) ?? []
            const inMonth = day.getMonth() === anchor.getMonth()
            return (
              <div
                key={key}
                onClick={() => openNew(day)}
                className={`min-h-0 cursor-pointer overflow-hidden border-r border-b border-line p-1 ${inMonth ? '' : 'bg-surface-2/40 text-ink-muted'}`}
              >
                <span
                  className={`mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${key === today ? 'bg-accent font-semibold text-accent-ink' : ''}`}
                >
                  {day.getDate()}
                </span>
                {occs.slice(0, 3).map((o, i) => (
                  <button
                    key={`${o.eventId}-${i}`}
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      const full = eventById.get(o.eventId)
                      if (full) setDialog({ isNew: false, event: full })
                    }}
                    className="mb-0.5 block w-full truncate rounded bg-accent/15 px-1 text-left text-[11px] leading-4 text-accent hover:bg-accent/25"
                  >
                    {!o.allDay && <span className="tabular-nums">{timeFmt.format(o.start)} </span>}
                    {eventById.get(o.eventId)?.title || '—'}
                  </button>
                ))}
                {occs.length > 3 && (
                  <span className="text-[10px] text-ink-muted">+{occs.length - 3}</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Mobile: agenda list for the visible month */}
      <div className="min-h-0 flex-1 overflow-y-auto sm:hidden">
        {[...byDay.entries()]
          .filter(([key]) => key.slice(0, 7) === dayKey(anchor).slice(0, 7))
          .map(([key, occs]) => (
            <div key={key}>
              <div className="sticky top-0 border-b border-line bg-surface px-4 py-1 text-xs font-semibold text-ink-muted">
                {agendaFmt.format(new Date(`${key}T12:00:00`))}
              </div>
              {occs.map((o, i) => (
                <button
                  key={`${o.eventId}-${i}`}
                  type="button"
                  onClick={() => {
                    const full = eventById.get(o.eventId)
                    if (full) setDialog({ isNew: false, event: full })
                  }}
                  className="flex w-full items-baseline gap-3 border-b border-line px-4 py-2.5 text-left hover:bg-surface-2"
                >
                  <span className="w-14 shrink-0 text-xs text-ink-muted tabular-nums">
                    {o.allDay ? '—' : timeFmt.format(o.start)}
                  </span>
                  <span className="truncate text-sm">{eventById.get(o.eventId)?.title}</span>
                </button>
              ))}
            </div>
          ))}
      </div>

      {dialog && (
        <EventDialog
          initial={dialog.event}
          onClose={() => setDialog(null)}
          onSave={onDialogSave}
          onDelete={
            dialog.isNew
              ? null
              : () => {
                  setDialog(null)
                  void deleteEvent(account.id, dialog.event.id).then(() =>
                    showSnackbar({ message: t('cal.deleted') }),
                  )
                }
          }
        />
      )}
    </div>
  )
}
