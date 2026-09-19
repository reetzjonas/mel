import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { memo, useDeferredValue, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import type {
  Calendar,
  CalendarEvent,
  Occurrence,
  ParticipationStatus,
} from '../../domain/calendar'
import { CalendarDialog } from '../../features/calendar/CalendarDialog'
import { CALENDAR_SWATCHES, FALLBACK_COLORS } from '../../features/calendar/calendarColors'
import { EventDialog } from '../../features/calendar/EventDialog'
import { NotificationsDialog } from '../../features/calendar/NotificationsDialog'
import { ScopeDialog } from '../../features/calendar/ScopeDialog'
import { TimeGrid } from '../../features/calendar/TimeGrid'
import { dayKey } from '../../lib/dates'
import { instantAt } from '../../features/calendar/dragGeometry'
import {
  useCalendars,
  useEventNotifications,
  useEvents,
  useSelfIdentity,
} from '../../features/calendar/hooks'
import { useAccounts } from '../../features/mail/hooks'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { useHiddenCalendars } from '../../lib/hiddenCalendars'
import { t, currentLocale } from '../../lib/i18n'
import { scheduleSettingsSync } from '../../services/settings'
import {
  occurrenceEvent,
  patchFor,
  seriesFromOccurrence,
  withOverride,
  withoutOccurrence,
} from '../../lib/occurrence'
import { expandAll, rescheduleEvent } from '../../lib/recurrence'
import {
  BIRTHDAY_CALENDAR_ID,
  BIRTHDAY_COLOR,
  birthdayEvents,
  contactIdOfBirthday,
  isBirthdayEventId,
} from '../../features/calendar/birthdays'
import { useContacts } from '../../features/contacts/hooks'
import { PANEL_WIDTH_VAR, usePanelWidth, type PanelLimits } from '../../lib/panelWidths'
import { createEvent, deleteEvent, rsvpEvent, updateEvent } from '../../services/calendar'
import { Icon } from '../../ui/Icon'
import { ResizeHandle } from '../../ui/ResizeHandle'
import { SearchInput } from '../../ui/SearchInput'
import {
  primaryButtonClass,
  secondaryButtonClass,
  secondaryIconButtonClass,
  segmentedControlClass,
  segmentedOptionClass,
} from '../../ui/styles'

// Narrower than Mail's sidebar: a colour dot and a calendar name need less
// room than a folder list's icons and unread counts do.
const SIDEBAR_LIMITS: PanelLimits = { min: 160, max: 360, initial: 208 }

export const Route = createFileRoute('/calendar')({
  component: CalendarApp,
})

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Marks an event in flight; a day cell answers "may I take this?" from it. */
const EVENT_DRAG_TYPE = 'application/x-mel-event'
type ViewMode = 'month' | 'week' | 'day'

/** How far ahead the sidebar's "Upcoming" list looks. */
const UPCOMING_WINDOW_DAYS = 180
/** Rows shown at once — a sidebar list, not a full search results page. */
const UPCOMING_LIMIT = 8

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
  /** Set when the dialog is showing one occurrence of a series. */
  recurrenceId: string | null
}

/**
 * An edit to one occurrence of a series, waiting for the user to say how far
 * it reaches.
 *
 * The edit is already worked out by the time this exists — the question is
 * only whether it is written as an override or applied to the series — so the
 * answer costs one call either way, and cancelling costs nothing.
 */
interface ScopeQuestion {
  kind: 'edit' | 'delete'
  series: CalendarEvent
  recurrenceId: string
  /** The occurrence as edited; unused by a delete. */
  edited: CalendarEvent
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
  onEdit,
}: {
  name: string
  color: string
  hidden: boolean
  onToggle: () => void
  /** Absent for a calendar that cannot be edited (the derived birthdays one). */
  onEdit?: () => void
}) {
  return (
    <div className="group flex items-center rounded-control pr-1.5 transition-colors hover:bg-surface-2">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-[7px] pl-2.5 text-[13px]">
        <input type="checkbox" checked={!hidden} onChange={onToggle} className="sr-only" />
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color, opacity: hidden ? 0.25 : 1 }}
        />
        <span className={`truncate ${hidden ? 'text-ink-muted line-through' : ''}`}>{name}</span>
      </label>
      {onEdit && (
        // A fixed box that only fades in, so a hovered row is no taller than the rest.
        <button
          type="button"
          aria-label={`${t('cal.calendar.editLabel')}: ${name}`}
          onClick={onEdit}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
        >
          <Icon name="draft" size={12} />
        </button>
      )}
    </div>
  )
}

interface UpcomingRow {
  key: string
  title: string
  start: Date
  color: string | null
  dateLabel: string
  /** Empty for an all-day occurrence — nothing follows the date then. */
  timeLabel: string
}

/**
 * The sidebar's "Upcoming" section, `memo`'d so a grid drag's per-pointermove
 * re-renders of `CalendarApp` skip it entirely rather than re-reconciling up
 * to `UPCOMING_LIMIT` rows on every frame of the gesture — see the comment on
 * `upcomingRows` for why that mattered in practice, not just in theory.
 */
const UpcomingList = memo(function UpcomingList({
  rows,
  emptyLabel,
  onPick,
}: {
  rows: UpcomingRow[]
  emptyLabel: string
  onPick: (start: Date) => void
}) {
  if (rows.length === 0) return <p className="text-xs text-ink-subtle">{emptyLabel}</p>
  return (
    <div className="-mx-1.5 flex flex-col gap-0.5">
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          onClick={() => onPick(row.start)}
          className="flex items-center gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2"
        >
          <span
            className="h-6 w-1 shrink-0 rounded-full"
            style={{ backgroundColor: row.color ?? 'var(--mel-accent)' }}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-ink">{row.title}</span>
            <span className="block text-[11px] text-ink-subtle">
              {row.dateLabel}
              {row.timeLabel && ` · ${row.timeLabel}`}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
})

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
  const [calSearch, setCalSearch] = useState('')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  /** The calendar-list dialog: a calendar to edit, 'new' for a fresh one. */
  const notifications = useEventNotifications(account?.id)
  const [showNotifications, setShowNotifications] = useState(false)
  const [calendarDialog, setCalendarDialog] = useState<Calendar | 'new' | null>(null)
  const [scope, setScope] = useState<ScopeQuestion | null>(null)
  const sidebarPanel = usePanelWidth('calendar-sidebar', SIDEBAR_LIMITS)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const { hidden, toggle: toggleHiddenCalendar } = useHiddenCalendars(account?.id)
  // Mirrors the toggle to the server, where the account offers file storage —
  // see services/settings.ts. Kept at the UI call site rather than inside the
  // toggle itself, so the toggle stays a plain localStorage helper other
  // callers (a remote-applied value) can use without also pushing.
  const toggleCalendar = (calendarId: string) => {
    toggleHiddenCalendar(calendarId)
    if (account?.id) void scheduleSettingsSync(account.id, ['hiddenCalendars'])
  }
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

  /*
   * The sidebar's "Upcoming" list — independent of `grid`/`anchor`, so
   * navigating the visible month doesn't change what search finds. Birthdays'
   * ids are stable regardless of which month seeded `birthdayEvents`'
   * anchor year, so `shownBirthdays` (already respecting the hide toggle)
   * is a correct source here too, not just for the grid's own window.
   *
   * Deferred: expanding every series out to 180 days is real work, and this
   * list is a sidebar nicety, not the interaction someone is waiting on. Every
   * write — including the one a grid drag makes mid-gesture, to ask "this one
   * or all of them?" — otherwise recomputes it synchronously in the same
   * render as that urgent dialog, which measurably delayed the dialog under
   * load (see the e2e bisection in the #93 phase 2 commit).
   */
  const deferredEvents = useDeferredValue(visibleEvents)
  const deferredBirthdays = useDeferredValue(shownBirthdays)
  const upcoming = useMemo(() => {
    const from = new Date()
    const to = new Date(from.getTime() + UPCOMING_WINDOW_DAYS * 86_400_000)
    return expandAll([...deferredEvents, ...deferredBirthdays], from, to, VIEWER_ZONE)
  }, [deferredEvents, deferredBirthdays])

  const eventById = useMemo(
    () => new Map([...(events ?? []), ...birthdays].map((e) => [e.id, e])),
    [events, birthdays],
  )

  /*
   * Resolved once, off the deferred `upcoming` list — title, color and the
   * formatted labels — rather than in the row's JSX. A grid drag re-renders
   * this component on every pointermove to preview the placement, and
   * re-running `Intl.DateTimeFormat.format()` for up to `UPCOMING_LIMIT` rows
   * on every one of those is exactly the synchronous cost `useDeferredValue`
   * above doesn't cover by itself — `UpcomingList` below still has to be
   * skipped by `memo`, and it can only do that if this array is a stable
   * reference (unchanged) across those renders, not fresh objects every time.
   */
  const upcomingRows = useMemo(
    () =>
      upcoming.flatMap((occ) => {
        const base = eventById.get(occ.eventId)
        if (!base) return []
        const ev = occ.recurrenceId ? occurrenceEvent(base, occ.recurrenceId) : base
        return [
          {
            key: `${occ.eventId}-${occ.recurrenceId ?? ''}-${occ.start.toISOString()}`,
            title: ev.title,
            start: occ.start,
            color: colorFor(calendars ?? [], Object.keys(ev.calendarIds)[0]),
            dateLabel: agendaFmt.format(occ.start),
            timeLabel: occ.allDay ? '' : timeFmt.format(occ.start),
          },
        ]
      }),
    [upcoming, eventById, calendars],
  )

  if (!account?.capabilities.calendars)
    return <CapabilityNotice reason="caps.unsupported.calendar" />

  const eventColor = (e: CalendarEvent) => colorFor(calendars ?? [], Object.keys(e.calendarIds)[0])
  const defaultCalendarId = calendars?.find((c) => c.isDefault)?.id ?? calendars?.[0]?.id ?? null

  function openNew(day: Date, minutes?: number) {
    if (!defaultCalendarId) return
    const start = new Date(day)
    if (minutes !== undefined) start.setHours(0, minutes, 0, 0)
    setDialog({
      isNew: true,
      recurrenceId: null,
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
        recurrenceOverrides: {},
        participants: [],
        isOrganizerCopy: true,
      },
    })
  }

  /**
   * The event as one occurrence of it stands.
   *
   * A series occurrence may carry its own title, time or place, so every
   * screen asks for the occurrence rather than reading the series: showing
   * "Standup" on the one that was renamed to "Standup (with Ana)" would be the
   * override quietly not being there.
   */
  function eventFor(occ: Occurrence): CalendarEvent | undefined {
    const base = eventById.get(occ.eventId)
    if (!base) return undefined
    return occ.recurrenceId ? occurrenceEvent(base, occ.recurrenceId) : base
  }

  const upcomingNeedle = calSearch.trim().toLowerCase()
  const upcomingMatches = upcomingNeedle
    ? upcomingRows.filter((r) => r.title.toLowerCase().includes(upcomingNeedle))
    : upcomingRows
  const shownUpcoming = upcomingMatches.slice(0, UPCOMING_LIMIT)

  function openEdit(occ: Occurrence) {
    // A birthday has no event behind it to edit; the card it came from is the
    // only thing there is to open.
    if (isBirthdayEventId(occ.eventId)) {
      void navigate({
        to: '/contacts/$contactId',
        params: { contactId: contactIdOfBirthday(occ.eventId) },
      })
      return
    }
    const base = eventById.get(occ.eventId)
    if (!base) return
    // Only a real series gets an occurrence id in the dialog: an event with no
    // rule has nothing to scope an edit against, and asking "this one or all?"
    // about a single event is a question with one answer.
    const recurrenceId = base.recurrenceRule ? occ.recurrenceId : null
    setDialog({
      isNew: false,
      recurrenceId,
      event: recurrenceId ? occurrenceEvent(base, recurrenceId) : base,
    })
  }

  /**
   * What a drag may pick up.
   *
   * Birthdays are not events on any server, and an invitation is somebody
   * else's event to move. A series may be dragged: where it lands is written
   * as an override for that one occurrence, or applied to the whole series,
   * depending on what the question after the drop is answered with.
   */
  function canMove(e: CalendarEvent): boolean {
    return !isBirthdayEventId(e.id) && e.isOrganizerCopy
  }

  /**
   * Apply an edit to one occurrence, or to the series it belongs to.
   *
   * Both are one write of the whole event, so both undo the same way: put back
   * the event as it was. The override path keeps the series untouched, and the
   * series path drops this occurrence's own patch — see seriesFromOccurrence.
   */
  function applyScope(q: ScopeQuestion, all: boolean) {
    const accountId = account!.id
    const before = q.series
    const next =
      q.kind === 'delete'
        ? withoutOccurrence(before, q.recurrenceId)
        : all
          ? seriesFromOccurrence(before, q.recurrenceId, q.edited)
          : withOverride(before, q.recurrenceId, patchFor(before, q.recurrenceId, q.edited))

    setScope(null)
    if (q.kind === 'delete' && all) {
      void deleteEvent(accountId, before.id).then(() => showSnackbar({ message: t('cal.deleted') }))
      return
    }
    void updateEvent(accountId, next).then(() =>
      showSnackbar({
        message: q.kind === 'delete' ? t('cal.deleted') : t('cal.moved'),
        actionLabel: t('mail.undo'),
        action: () => void updateEvent(accountId, before),
      }),
    )
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
    onEventDrop(occ, start, new Date(start.getTime() + (occ.end.getTime() - occ.start.getTime())))
  }

  function onEventDrop(occ: Occurrence, start: Date, end: Date) {
    const before = eventById.get(occ.eventId)
    if (!before || !canMove(before)) return
    const accountId = account!.id

    // One occurrence of a series has to be asked about before anything is
    // written: moving all of them and moving one of them are both reasonable
    // readings of the same gesture.
    if (before.recurrenceRule && occ.recurrenceId) {
      const moved = rescheduleEvent(
        occurrenceEvent(before, occ.recurrenceId),
        start,
        end,
        VIEWER_ZONE,
      )
      setScope({ kind: 'edit', series: before, recurrenceId: occ.recurrenceId, edited: moved })
      return
    }

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
    const open = dialog
    setDialog(null)
    if (!open) return
    if (open.isNew) {
      const { id: _id, ...rest } = e
      void createEvent(account!.id, rest)
      return
    }
    const series = open.recurrenceId ? eventById.get(e.id) : undefined
    if (open.recurrenceId && series) {
      /*
       * The repeat picker and the calendar picker are series-wide: neither can
       * be said about one occurrence, so changing one is an edit to the series
       * whatever the answer would have been. Asking anyway would be offering a
       * choice that only has one answer.
       */
      const seriesWide =
        (e.recurrenceRule?.frequency ?? null) !== (series.recurrenceRule?.frequency ?? null) ||
        Object.keys(e.calendarIds).join() !== Object.keys(series.calendarIds).join()
      const question: ScopeQuestion = {
        kind: 'edit',
        series,
        recurrenceId: open.recurrenceId,
        edited: e,
      }
      if (seriesWide) applyScope(question, true)
      else setScope(question)
      return
    }
    void updateEvent(account!.id, e)
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
      <aside
        ref={sidebarRef}
        data-testid="calendar-sidebar"
        style={{ [PANEL_WIDTH_VAR]: `${sidebarPanel.width}px` } as React.CSSProperties}
        className="hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto py-3 lg:flex lg:w-[var(--mel-panel-w)]"
      >
        <div className="mb-1.5 flex items-center justify-between pr-1.5 pl-2.5">
          <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase">
            {t('cal.calendars')}
          </span>
          {account.capabilities.calendarCreate !== false && (
            <button
              type="button"
              aria-label={t('cal.calendar.new')}
              onClick={() => setCalendarDialog('new')}
              className="flex h-5 w-5 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="plus" size={13} />
            </button>
          )}
        </div>
        {(calendars ?? []).map((c, i) => (
          <CalendarToggle
            key={c.id}
            name={c.name}
            color={c.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!}
            hidden={hidden.has(c.id)}
            onToggle={() => toggleCalendar(c.id)}
            onEdit={c.mayWrite ? () => setCalendarDialog(c) : undefined}
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

        <div className="mt-3 flex flex-col gap-2 border-t border-line px-2.5 pt-3">
          <SearchInput
            value={calSearch}
            onChange={setCalSearch}
            placeholder={t('cal.searchPlaceholder')}
            clearLabel={t('search.clear')}
          />
          <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-subtle uppercase">
            {t('cal.upcoming')}
          </span>
          <UpcomingList
            rows={shownUpcoming}
            emptyLabel={calSearch ? t('cal.searchNoResults') : t('cal.upcomingEmpty')}
            onPick={setAnchor}
          />
        </div>
      </aside>

      <ResizeHandle
        limits={SIDEBAR_LIMITS}
        label={t('cal.resizeSidebar')}
        width={sidebarPanel.width}
        targetRef={sidebarRef}
        onCommit={sidebarPanel.commit}
        onReset={sidebarPanel.reset}
      />

      <div
        data-testid="calendar-grid"
        className="panel flex min-w-0 flex-1 flex-col overflow-hidden max-sm:rounded-none max-sm:shadow-none"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setAnchor(new Date())}
            className={`!px-3 !py-1.5 ${secondaryButtonClass}`}
          >
            {t('cal.today')}
          </button>
          <button
            type="button"
            aria-label="previous"
            onClick={() => step(-1)}
            className={`!p-1.5 ${secondaryIconButtonClass}`}
          >
            <Icon name="back" size={15} />
          </button>
          <button
            type="button"
            aria-label="next"
            onClick={() => step(1)}
            className={`!p-1.5 ${secondaryIconButtonClass}`}
          >
            <Icon name="forward" size={15} />
          </button>
          <h1 className="text-base font-semibold capitalize">{heading}</h1>

          <div className={`ml-2 hidden sm:flex ${segmentedControlClass}`}>
            {(['month', 'week', 'day'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={segmentedOptionClass(view === v)}
              >
                {t(`cal.view.${v}`)}
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-label={`${t('cal.notif.button')}${
              notifications?.length ? ` (${notifications.length})` : ''
            }`}
            onClick={() => setShowNotifications(true)}
            className={`relative ml-auto !p-1.5 ${secondaryIconButtonClass}`}
          >
            <Icon name="bell" size={15} />
            {notifications && notifications.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-ink">
                {notifications.length > 99 ? '99+' : notifications.length}
              </span>
            )}
          </button>

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
            className={`flex items-center gap-2 !py-1.5 ${primaryButtonClass}`}
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
                      const ev = eventFor(o)
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
                            openEdit(o)
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
              eventFor={eventFor}
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
                    const ev = eventFor(o)
                    const color = ev ? eventColor(ev) : null
                    return (
                      <button
                        key={`${o.eventId}-${i}`}
                        type="button"
                        onClick={() => openEdit(o)}
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

      {showNotifications && (
        <NotificationsDialog
          accountId={account.id}
          notifications={notifications ?? []}
          eventById={eventById}
          onClose={() => setShowNotifications(false)}
          onOpen={(event) => {
            setShowNotifications(false)
            setDialog({ isNew: false, recurrenceId: null, event })
          }}
        />
      )}

      {calendarDialog && (
        <CalendarDialog
          accountId={account.id}
          calendar={calendarDialog === 'new' ? null : calendarDialog}
          defaultColor={CALENDAR_SWATCHES[(calendars?.length ?? 0) % CALENDAR_SWATCHES.length]!}
          onClose={() => setCalendarDialog(null)}
        />
      )}

      {dialog && (
        <EventDialog
          initial={dialog.event}
          calendars={calendars ?? []}
          accountId={account.id}
          canUseFiles={Boolean(account.capabilities.files)}
          self={self}
          occurrence={dialog.recurrenceId !== null}
          onClose={() => setDialog(null)}
          onSave={onDialogSave}
          onRsvp={onDialogRsvp}
          onDelete={
            dialog.isNew
              ? null
              : () => {
                  const { event, recurrenceId } = dialog
                  const series = recurrenceId ? eventById.get(event.id) : undefined
                  setDialog(null)
                  if (recurrenceId && series) {
                    setScope({ kind: 'delete', series, recurrenceId, edited: event })
                    return
                  }
                  void deleteEvent(account.id, event.id).then(() =>
                    showSnackbar({ message: t('cal.deleted') }),
                  )
                }
          }
        />
      )}

      {scope && (
        <ScopeDialog
          kind={scope.kind}
          onChoose={(all) => applyScope(scope, all)}
          onClose={() => setScope(null)}
        />
      )}
    </div>
  )
}
