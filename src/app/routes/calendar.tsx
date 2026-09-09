import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useUi } from '../store'
import type {
  Calendar,
  CalendarEvent,
  Occurrence,
  ParticipationStatus,
} from '../../domain/calendar'
import { EventDialog } from '../../features/calendar/EventDialog'
import { dayKey, TimeGrid } from '../../features/calendar/TimeGrid'
import { useCalendars, useEvents, useSelfIdentity } from '../../features/calendar/hooks'
import { useAccounts } from '../../features/mail/hooks'
import { t, currentLocale } from '../../lib/i18n'
import { expandAll } from '../../lib/recurrence'
import { createEvent, deleteEvent, rsvpEvent, updateEvent } from '../../services/calendar'
import { Icon } from '../../ui/Icon'
import { primaryButtonClass } from '../../ui/styles'

export const Route = createFileRoute('/calendar')({
  component: CalendarApp,
})

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
type ViewMode = 'month' | 'week' | 'day'

// Fixed, deterministic palette for calendars the server didn't color.
const FALLBACK_COLORS = ['#2d5bd1', '#0e9488', '#c2560f', '#7c3aed', '#b91c62', '#4d7c0f']

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

function weekGrid(anchor: Date): Date[] {
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

const monthFmt = new Intl.DateTimeFormat(currentLocale, { month: 'long', year: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat(currentLocale, { weekday: 'short' })
const agendaFmt = new Intl.DateTimeFormat(currentLocale, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})
const timeFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })
const dayTitleFmt = new Intl.DateTimeFormat(currentLocale, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})
const weekRangeFmt = new Intl.DateTimeFormat(currentLocale, { day: 'numeric', month: 'short' })

interface DialogState {
  event: CalendarEvent
  isNew: boolean
}

function hiddenCalendarsKey(accountId: string) {
  return `mel:cal:hidden:${accountId}`
}

function useHiddenCalendars(accountId: string | undefined) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!accountId) return
    try {
      const raw = localStorage.getItem(hiddenCalendarsKey(accountId))
      setHidden(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch {
      setHidden(new Set())
    }
  }, [accountId])

  const toggle = (calendarId: string) => {
    if (!accountId) return
    setHidden((cur) => {
      const next = new Set(cur)
      if (next.has(calendarId)) next.delete(calendarId)
      else next.add(calendarId)
      localStorage.setItem(hiddenCalendarsKey(accountId), JSON.stringify([...next]))
      return next
    })
  }

  return { hidden, toggle }
}

function colorFor(calendars: Calendar[], calendarId: string | undefined): string | null {
  if (!calendarId) return null
  const cal = calendars.find((c) => c.id === calendarId)
  if (cal?.color) return cal.color
  const idx = calendars.findIndex((c) => c.id === calendarId)
  return idx >= 0 ? FALLBACK_COLORS[idx % FALLBACK_COLORS.length]! : null
}

function CalendarApp() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const calendars = useCalendars(account?.id)
  const events = useEvents(account?.id)
  const { showSnackbar } = useUi()
  const [anchor, setAnchor] = useState(() => new Date())
  const [view, setView] = useState<ViewMode>('month')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const { hidden, toggle: toggleCalendar } = useHiddenCalendars(account?.id)
  const self = useSelfIdentity(account)

  const visibleEvents = useMemo(
    () => (events ?? []).filter((e) => !Object.keys(e.calendarIds).every((id) => hidden.has(id))),
    [events, hidden],
  )

  const grid = useMemo(() => {
    if (view === 'month') return monthGrid(anchor)
    if (view === 'week') return weekGrid(anchor)
    return [anchor]
  }, [view, anchor])

  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>()
    if (!visibleEvents.length || !grid.length) return map
    // Normalize to midnight: `anchor` (and thus week/day grids derived from
    // it) carries the real current time-of-day, which would otherwise shift
    // this window away from a clean day boundary and drop early events.
    const first = grid[0]!
    const last = grid[grid.length - 1]!
    const from = new Date(first.getFullYear(), first.getMonth(), first.getDate())
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
    for (const occ of expandAll(visibleEvents, from, to, VIEWER_ZONE)) {
      const key = dayKey(occ.start)
      const list = map.get(key) ?? []
      list.push(occ)
      map.set(key, list)
    }
    return map
  }, [visibleEvents, grid])

  if (!account?.capabilities.calendars) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-muted">
        <p className="text-sm">{t('caps.unsupported.calendar')}</p>
        <Link to="/settings" className="text-sm text-accent hover:underline">
          {t('caps.showDetails')}
        </Link>
      </div>
    )
  }

  const eventById = new Map((events ?? []).map((e) => [e.id, e]))
  const eventColor = (e: CalendarEvent) => colorFor(calendars ?? [], Object.keys(e.calendarIds)[0])
  const defaultCalendarId =
    calendars?.find((c) => c.isDefault)?.id ?? calendars?.[0]?.id ?? null

  function openNew(day: Date, minutes?: number) {
    if (!defaultCalendarId) return
    const start = new Date(day)
    if (minutes !== undefined) start.setHours(0, minutes, 0, 0)
    setDialog({
      isNew: true,
      event: {
        id: '',
        calendarIds: { [defaultCalendarId]: true },
        uid: crypto.randomUUID(),
        title: '',
        description: '',
        location: '',
        start: minutes === undefined ? `${dayKey(day)}T10:00:00` : `${dayKey(start)}T${start.toTimeString().slice(0, 8)}`,
        timeZone: VIEWER_ZONE,
        duration: 'PT1H',
        showWithoutTime: false,
        status: 'confirmed',
        recurrenceRule: null,
        participants: [],
        isOrganizerCopy: true,
      },
    })
  }

  function openEdit(eventId: string) {
    const full = eventById.get(eventId)
    if (full) setDialog({ isNew: false, event: full })
  }

  function onDialogSave(e: CalendarEvent) {
    const isNew = dialog?.isNew
    setDialog(null)
    if (isNew) {
      const { id: _id, ...rest } = e
      void createEvent(account!.id, rest)
    } else {
      void updateEvent(account!.id, e)
    }
  }

  function onDialogRsvp(status: ParticipationStatus) {
    if (!dialog) return
    setDialog(null)
    void rsvpEvent(account!.id, dialog.event, self.email, status).then(() =>
      showSnackbar({ message: t('cal.rsvpSent') }),
    )
  }

  function step(dir: 1 | -1) {
    const d = new Date(anchor)
    if (view === 'month') d.setMonth(d.getMonth() + dir)
    else if (view === 'week') d.setDate(d.getDate() + dir * 7)
    else d.setDate(d.getDate() + dir)
    setAnchor(d)
  }

  const today = dayKey(new Date())
  const weekdays = monthGrid(anchor).slice(0, 7).map((d) => weekdayFmt.format(d))

  const heading =
    view === 'month'
      ? monthFmt.format(anchor)
      : view === 'day'
        ? dayTitleFmt.format(anchor)
        : `${weekRangeFmt.format(grid[0]!)} – ${weekRangeFmt.format(grid[6]!)}`

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      <aside className="hidden w-52 shrink-0 flex-col gap-0.5 py-3 lg:flex">
        <span className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase">
          {t('cal.calendars')}
        </span>
        {(calendars ?? []).map((c, i) => (
          <label
            key={c.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-[7px] text-[13px] transition-colors hover:bg-surface-2"
          >
            <input
              type="checkbox"
              checked={!hidden.has(c.id)}
              onChange={() => toggleCalendar(c.id)}
              className="sr-only"
            />
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                backgroundColor: c.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
                opacity: hidden.has(c.id) ? 0.25 : 1,
              }}
            />
            <span className={`truncate ${hidden.has(c.id) ? 'text-ink-muted line-through' : ''}`}>
              {c.name}
            </span>
          </label>
        ))}
      </aside>

      <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setAnchor(new Date())}
            className="rounded-control border border-line px-3 py-1.5 text-sm transition-colors hover:bg-surface-2"
          >
            {t('cal.today')}
          </button>
          <button
            type="button"
            aria-label="previous"
            onClick={() => step(-1)}
            className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2"
          >
            <Icon name="back" size={15} />
          </button>
          <button
            type="button"
            aria-label="next"
            onClick={() => step(1)}
            className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2"
          >
            <Icon name="forward" size={15} />
          </button>
          <h1 className="text-base font-semibold capitalize">{heading}</h1>

          <div className="ml-2 hidden items-center gap-0.5 rounded-control bg-surface-2 p-0.5 sm:flex">
            {(['month', 'week', 'day'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${view === v ? 'bg-raised text-ink shadow-raised' : 'text-ink-muted hover:text-ink'}`}
              >
                {t(`cal.view.${v}`)}
              </button>
            ))}
          </div>

          {/* Without a calendar there is nothing to create an event in, and
              openNew() would return silently — a button that does nothing when
              pressed. Disabled until the calendar list has actually arrived. */}
          <button
            type="button"
            disabled={!defaultCalendarId}
            title={defaultCalendarId ? undefined : t('cal.loading')}
            onClick={() => openNew(view === 'month' ? new Date() : anchor)}
            className={`ml-auto flex items-center gap-2 !py-1.5 ${primaryButtonClass}`}
          >
            <Icon name="compose" size={14} />
            <span className="hidden sm:inline">{t('cal.newEvent')}</span>
          </button>
        </header>

        {/* Desktop: month grid */}
        {view === 'month' && (
          <div className="hidden min-h-0 flex-1 flex-col sm:flex">
            <div className="grid grid-cols-7 border-b border-line text-center text-[11px] font-semibold tracking-wide text-ink-subtle uppercase">
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
                    className={`min-h-0 cursor-pointer overflow-hidden border-r border-b border-line p-1 transition-colors hover:bg-surface-2/50 ${inMonth ? '' : 'bg-surface-2/30 text-ink-subtle'}`}
                  >
                    <span
                      className={`mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${key === today ? 'bg-accent font-semibold text-accent-ink shadow-raised' : ''}`}
                    >
                      {day.getDate()}
                    </span>
                    {occs.slice(0, 3).map((o, i) => {
                      const ev = eventById.get(o.eventId)
                      const color = ev ? eventColor(ev) : null
                      return (
                        <button
                          key={`${o.eventId}-${i}`}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            openEdit(o.eventId)
                          }}
                          style={color ? { backgroundColor: `${color}26`, color } : undefined}
                          className={`mb-0.5 block w-full truncate rounded px-1 text-left text-[11px] leading-4 transition-opacity hover:opacity-80 ${!color ? 'bg-accent-wash text-accent' : ''}`}
                        >
                          {!o.allDay && (
                            <span className="tabular-nums">{timeFmt.format(o.start)} </span>
                          )}
                          {ev?.title || '—'}
                        </button>
                      )
                    })}
                    {occs.length > 3 && (
                      <span className="text-[10px] text-ink-muted">+{occs.length - 3}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Desktop: week/day time grid */}
        {view !== 'month' && (
          <div className="hidden min-h-0 flex-1 sm:flex">
            <TimeGrid
              days={grid}
              eventsByDay={byDay}
              eventById={eventById}
              calendarColor={eventColor}
              onSlotClick={openNew}
              onEventClick={openEdit}
              today={today}
            />
          </div>
        )}

        {/* Mobile: agenda list for the visible range */}
        <div className="min-h-0 flex-1 overflow-y-auto sm:hidden">
          {[...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, occs]) => (
              <div key={key}>
                <div className="sticky top-0 z-10 bg-surface/90 px-4 py-1 text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase backdrop-blur-sm">
                  {agendaFmt.format(new Date(`${key}T12:00:00`))}
                </div>
                {occs.map((o, i) => {
                  const ev = eventById.get(o.eventId)
                  const color = ev ? eventColor(ev) : null
                  return (
                    <button
                      key={`${o.eventId}-${i}`}
                      type="button"
                      onClick={() => openEdit(o.eventId)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <span
                        className="h-8 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: color ?? 'var(--mel-accent)' }}
                      />
                      <span className="w-14 shrink-0 text-xs text-ink-subtle tabular-nums">
                        {o.allDay ? '—' : timeFmt.format(o.start)}
                      </span>
                      <span className="truncate text-sm">{ev?.title}</span>
                    </button>
                  )
                })}
              </div>
            ))}
        </div>
      </div>

      {dialog && (
        <EventDialog
          initial={dialog.event}
          calendars={calendars ?? []}
          accountId={account.id}
          self={self}
          onClose={() => setDialog(null)}
          onSave={onDialogSave}
          onRsvp={onDialogRsvp}
          onDelete={
            dialog.isNew
              ? null
              : () => {
                  const eventId = dialog.event.id
                  setDialog(null)
                  void deleteEvent(account.id, eventId).then(() =>
                    showSnackbar({ message: t('cal.deleted') }),
                  )
                }
          }
        />
      )}
    </div>
  )
}
