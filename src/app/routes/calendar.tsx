import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import type {
  Calendar,
  CalendarEvent,
  Occurrence,
  ParticipationStatus,
} from '../../domain/calendar'
import { EventDialog } from '../../features/calendar/EventDialog'
import { TimeGrid } from '../../features/calendar/TimeGrid'
import { dayKey } from '../../lib/dates'
import { instantAt } from '../../features/calendar/dragGeometry'
import { useCalendars, useEvents, useSelfIdentity } from '../../features/calendar/hooks'
import { useAccounts } from '../../features/mail/hooks'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { t, currentLocale } from '../../lib/i18n'
import { expandAll, rescheduleEvent } from '../../lib/recurrence'
import {
  BIRTHDAY_CALENDAR_ID,
  BIRTHDAY_COLOR,
  birthdayEvents,
  contactIdOfBirthday,
  isBirthdayEventId,
} from '../../features/calendar/birthdays'
import { useContacts } from '../../features/contacts/hooks'
import { createEvent, deleteEvent, rsvpEvent, updateEvent } from '../../services/calendar'
import { Icon } from '../../ui/Icon'
import { primaryButtonClass } from '../../ui/styles'

export const Route = createFileRoute('/calendar')({
  component: CalendarApp,
})

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Marks an event in flight; a day cell answers "may I take this?" from it. */
const EVENT_DRAG_TYPE = 'application/x-mel-event'
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
      /*
       * localStorage is an external system and the account it is keyed by can
       * change, so this is a synchronisation rather than derivable state. A
       * lazy initialiser would read it once and then answer for the wrong
       * account after a switch.
       */
      // oxlint-disable-next-line set-state-in-effect
      setHidden(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch {
      // oxlint-disable-next-line set-state-in-effect
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
  if (calendarId === BIRTHDAY_CALENDAR_ID) return BIRTHDAY_COLOR
  const cal = calendars.find((c) => c.id === calendarId)
  if (cal?.color) return cal.color
  const idx = calendars.findIndex((c) => c.id === calendarId)
  return idx >= 0 ? FALLBACK_COLORS[idx % FALLBACK_COLORS.length]! : null
}

/** One row of the calendar list: a colour, a name, and whether it is showing. */
function CalendarToggle({
  name,
  color,
  hidden,
  onToggle,
}: {
  name: string
  color: string
  hidden: boolean
  onToggle: () => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-[7px] text-[13px] transition-colors hover:bg-surface-2">
      <input type="checkbox" checked={!hidden} onChange={onToggle} className="sr-only" />
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color, opacity: hidden ? 0.25 : 1 }}
      />
      <span className={`truncate ${hidden ? 'text-ink-muted line-through' : ''}`}>{name}</span>
    </label>
  )
}

function CalendarApp() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const calendars = useCalendars(account?.id)
  const contacts = useContacts(account?.id)
  const events = useEvents(account?.id)
  const { showSnackbar } = useUi()
  const navigate = useNavigate()
  const [anchor, setAnchor] = useState(() => new Date())
  const [view, setView] = useState<ViewMode>('month')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const { hidden, toggle: toggleCalendar } = useHiddenCalendars(account?.id)
  /* The occurrence in flight across the month grid, and the cell under it. The
     payload cannot be read during a dragover, so the source keeps it here. */
  const dragged = useRef<Occurrence | null>(null)
  const [dropDay, setDropDay] = useState<string | null>(null)
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

  /*
   * Birthdays are not events on any server: they are derived from the contact
   * cards for the window on screen and expanded by the same machinery as the
   * real ones, so a yearly series behaves identically. Nothing is stored, and
   * clicking one leads to the card rather than to an editor.
   */
  const birthdays = useMemo(
    () => (grid.length ? birthdayEvents(contacts ?? [], grid[0]!) : []),
    [contacts, grid],
  )
  // Built either way, so the sidebar can still offer the switch that is
  // currently hiding them — asking the contacts again is what builds them.
  const shownBirthdays = useMemo(
    () => (hidden.has(BIRTHDAY_CALENDAR_ID) ? [] : birthdays),
    [birthdays, hidden],
  )

  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>()
    const all = [...visibleEvents, ...shownBirthdays]
    if (!all.length || !grid.length) return map
    // Normalize to midnight: `anchor` (and thus week/day grids derived from
    // it) carries the real current time-of-day, which would otherwise shift
    // this window away from a clean day boundary and drop early events.
    const first = grid[0]!
    const last = grid[grid.length - 1]!
    const from = new Date(first.getFullYear(), first.getMonth(), first.getDate())
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
    for (const occ of expandAll(all, from, to, VIEWER_ZONE)) {
      const key = dayKey(occ.start)
      const list = map.get(key) ?? []
      list.push(occ)
      map.set(key, list)
    }
    return map
  }, [visibleEvents, shownBirthdays, grid])

  if (!account?.capabilities.calendars)
    return <CapabilityNotice reason="caps.unsupported.calendar" />

  const eventById = new Map([...(events ?? []), ...birthdays].map((e) => [e.id, e]))
  const eventColor = (e: CalendarEvent) => colorFor(calendars ?? [], Object.keys(e.calendarIds)[0])
  const defaultCalendarId = calendars?.find((c) => c.isDefault)?.id ?? calendars?.[0]?.id ?? null

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
        start:
          minutes === undefined
            ? `${dayKey(day)}T10:00:00`
            : `${dayKey(start)}T${start.toTimeString().slice(0, 8)}`,
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
    // A birthday has no event behind it to edit; the card it came from is the
    // only thing there is to open.
    if (isBirthdayEventId(eventId)) {
      void navigate({
        to: '/contacts/$contactId',
        params: { contactId: contactIdOfBirthday(eventId) },
      })
      return
    }
    const full = eventById.get(eventId)
    if (full) setDialog({ isNew: false, event: full })
  }

  /**
   * What a drag may pick up.
   *
   * A series is left alone because there is nowhere to put the answer: mel
   * cannot yet override a single occurrence (#5), so dragging one instance
   * would move every one of them — and on a rule with `byDay`, dragging it to
   * another weekday would do nothing at all. Birthdays are not events on any
   * server, and an invitation is somebody else's event to move.
   */
  function canMove(e: CalendarEvent): boolean {
    return !isBirthdayEventId(e.id) && !e.recurrenceRule && e.isOrganizerCopy
  }

  /**
   * Moving an event to another day in the month grid.
   *
   * Keeps the time of day and the length, changes only which day it is on —
   * the month grid has no time axis, so that is the whole of what a drop here
   * can mean.
   */
  function dropOnDay(day: Date) {
    const occ = dragged.current
    dragged.current = null
    if (!occ || dayKey(occ.start) === dayKey(day)) return
    const minutes = occ.start.getHours() * 60 + occ.start.getMinutes()
    const start = instantAt(day, minutes)
    onEventDrop(
      occ.eventId,
      start,
      new Date(start.getTime() + (occ.end.getTime() - occ.start.getTime())),
    )
  }

  function onEventDrop(eventId: string, start: Date, end: Date) {
    const before = eventById.get(eventId)
    if (!before || !canMove(before)) return
    const accountId = account!.id
    void updateEvent(accountId, rescheduleEvent(before, start, end, VIEWER_ZONE)).then(() =>
      // The event as it was is the whole undo: a drag rewrites two fields and
      // nothing else, so putting the old one back is exact rather than an
      // inverse someone has to keep correct.
      showSnackbar({
        message: t('cal.moved'),
        actionLabel: t('mail.undo'),
        action: () => void updateEvent(accountId, before),
      }),
    )
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
  const weekdays = monthGrid(anchor)
    .slice(0, 7)
    .map((d) => weekdayFmt.format(d))

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
          <CalendarToggle
            key={c.id}
            name={c.name}
            color={c.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!}
            hidden={hidden.has(c.id)}
            onToggle={() => toggleCalendar(c.id)}
          />
        ))}
        {/* The contacts' birthdays, as a calendar that exists only here. Offered
            only when there are some: a switch for an empty collection is a
            question nobody asked. */}
        {birthdays.length > 0 && (
          <CalendarToggle
            name={t('cal.birthdays')}
            color={BIRTHDAY_COLOR}
            hidden={hidden.has(BIRTHDAY_CALENDAR_ID)}
            onToggle={() => toggleCalendar(BIRTHDAY_CALENDAR_ID)}
          />
        )}
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
          {/* Stays a native title rather than <Tooltip>: a disabled control
              fires no mouse events, so nothing would ever open the bubble. */}
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
                    onDragOver={(e) => {
                      // Only the *types* are readable before the drop, which is
                      // exactly what "may I take this?" has to be answered from.
                      if (!e.dataTransfer.types.includes(EVENT_DRAG_TYPE)) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setDropDay(key)
                    }}
                    onDragLeave={() => setDropDay((d) => (d === key ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault()
                      setDropDay(null)
                      dropOnDay(day)
                    }}
                    className={`min-h-0 cursor-pointer overflow-hidden border-r border-b border-line p-1 transition-colors hover:bg-surface-2/50 ${inMonth ? '' : 'bg-surface-2/30 text-ink-subtle'} ${dropDay === key ? 'bg-accent-wash ring-1 ring-accent ring-inset' : ''}`}
                  >
                    <span
                      className={`mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${key === today ? 'bg-accent font-semibold text-accent-ink shadow-raised' : ''}`}
                    >
                      {day.getDate()}
                    </span>
                    {occs.slice(0, 3).map((o, i) => {
                      const ev = eventById.get(o.eventId)
                      const color = ev ? eventColor(ev) : null
                      const movable = Boolean(ev) && canMove(ev!)
                      return (
                        <button
                          key={`${o.eventId}-${i}`}
                          type="button"
                          draggable={movable}
                          onDragStart={(e) => {
                            e.stopPropagation()
                            dragged.current = o
                            // The payload is a type more than a value: both ends
                            // are this component, and a day cell only ever needs
                            // to recognise the kind of thing in flight.
                            e.dataTransfer.setData(EVENT_DRAG_TYPE, o.eventId)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => {
                            dragged.current = null
                            setDropDay(null)
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            openEdit(o.eventId)
                          }}
                          style={color ? { backgroundColor: `${color}26`, color } : undefined}
                          className={`mb-0.5 block w-full truncate rounded px-1 text-left text-[11px] leading-4 transition-opacity select-none hover:opacity-80 ${movable ? 'cursor-grab' : ''} ${!color ? 'bg-accent-wash text-accent' : ''}`}
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
              onEventDrop={onEventDrop}
              canMove={canMove}
              today={today}
            />
          </div>
        )}

        {/* Mobile: agenda list for the visible range */}
        <div className="min-h-0 flex-1 overflow-y-auto sm:hidden">
          {[...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, occs]) => {
              const past = key < today
              return (
                <div key={key}>
                  {/* Only the text dims: the heading needs its opaque
                      background to stay readable while it sticks. */}
                  <div
                    className={`sticky top-0 z-10 bg-surface/90 px-4 py-1 text-[11px] font-semibold tracking-[0.06em] uppercase backdrop-blur-sm ${key === today ? 'text-accent' : past ? 'text-ink-subtle/55' : 'text-ink-subtle'}`}
                  >
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
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 ${past ? 'opacity-55' : ''}`}
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
              )
            })}
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
