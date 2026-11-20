import { useMemo, useRef, useState } from 'react'
import type { CalendarEvent, Occurrence } from '../../domain/calendar'
import { dayKey } from '../../lib/dates'
import { currentLocale } from '../../lib/i18n'
import { lanesInUse, layoutBars, daysBetween, segmentsByDay, spansDays, barEnds } from './multiDay'

const EVENT_DRAG_TYPE = 'application/x-mel-event'
/** Lines of events a day shows before the rest become "+n". */
const MAX_LINES = 3

const timeFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })

/** On the month grid, a bar is anything on more than one day, and every all-day event. */
const isBar = (o: Occurrence) => o.allDay || spansDays(o)

/** The day of a week row under the pointer. */
function dayUnder(e: React.DragEvent, row: Element, days: number): number {
  const rect = row.getBoundingClientRect()
  const i = Math.floor(((e.clientX - rect.left) / rect.width) * days)
  return Number.isFinite(i) ? Math.min(days - 1, Math.max(0, i)) : 0
}

/**
 * The month view: six week rows. In each, events on more than one day are
 * bars across the days they cover, on lanes shared by the row, and the
 * rest are listed under them on their day.
 */
export function MonthGrid({
  days,
  month,
  occurrences,
  eventFor,
  eventColor,
  canMove,
  today,
  onDayClick,
  onEventClick,
  onMoveDays,
}: {
  /** Six weeks of days, Monday first. */
  days: Date[]
  /** The month shown (0–11); days outside it are dimmed. */
  month: number
  occurrences: Occurrence[]
  eventFor: (occ: Occurrence) => CalendarEvent | undefined
  eventColor: (event: CalendarEvent) => string | null
  canMove: (event: CalendarEvent) => boolean
  today: string
  onDayClick: (day: Date) => void
  onEventClick: (occ: Occurrence) => void
  /** An event dragged a whole number of days, keeping its time and length. */
  onMoveDays: (occ: Occurrence, days: number) => void
}) {
  /* The occurrence in flight and the day it was picked up on — any day of a
     bar — and the cell under it. The payload cannot be read during a
     dragover, so the source keeps it here. */
  const dragged = useRef<{ occ: Occurrence; from: Date } | null>(null)
  const [dropDay, setDropDay] = useState<string | null>(null)

  const weeks = useMemo(() => {
    const bars = occurrences.filter(isBar)
    const singles = occurrences.filter((o) => !isBar(o))
    return Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => {
      const week = days.slice(w * 7, w * 7 + 7)
      const rowBars = layoutBars(bars, week)
      return {
        week,
        bars: rowBars,
        lanes: lanesInUse(rowBars, week.length),
        singles: segmentsByDay(singles, week),
      }
    })
  }, [days, occurrences])

  /** `pickedUp` says which day the drag starts from: for a bar, the one under the pointer. */
  function item(
    o: Occurrence,
    key: string,
    pickedUp: (e: React.DragEvent) => Date,
    extra: string,
    style: React.CSSProperties,
    showTime: boolean,
  ) {
    const ev = eventFor(o)
    const color = ev ? eventColor(ev) : null
    const movable = Boolean(ev) && canMove(ev!)
    return (
      <button
        key={key}
        type="button"
        draggable={movable}
        onDragStart={(e) => {
          e.stopPropagation()
          dragged.current = { occ: o, from: pickedUp(e) }
          // The payload is a type more than a value: both ends are this
          // component, and a day only ever needs to recognise the kind of
          // thing in flight.
          e.dataTransfer.setData(EVENT_DRAG_TYPE, o.eventId)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => {
          dragged.current = null
          setDropDay(null)
        }}
        onClick={(e) => {
          e.stopPropagation()
          onEventClick(o)
        }}
        style={{ ...style, ...(color ? { backgroundColor: `${color}26`, color } : {}) }}
        className={`z-[1] min-w-0 truncate px-1 text-left text-[11px] leading-4 transition-opacity select-none hover:opacity-80 ${extra} ${movable ? 'cursor-grab' : ''} ${!color ? 'bg-accent-wash text-accent' : ''}`}
      >
        {showTime && <span className="tabular-nums">{timeFmt.format(o.start)} </span>}
        {ev?.title || '—'}
      </button>
    )
  }

  return (
    <div className="grid min-h-0 flex-1 grid-rows-6">
      {weeks.map(({ week, bars, lanes, singles }) => (
        <div
          key={dayKey(week[0]!)}
          data-testid="month-week"
          className="grid min-h-0 grid-cols-7 overflow-hidden"
          style={{ gridTemplateRows: `auto repeat(${MAX_LINES}, 1.0625rem) auto minmax(0, 1fr)` }}
          onDragOver={(e) => {
            // Only the *types* are readable before the drop, which is exactly
            // what "may I take this?" has to be answered from.
            if (!e.dataTransfer.types.includes(EVENT_DRAG_TYPE)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropDay(dayKey(week[dayUnder(e, e.currentTarget, week.length)]!))
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDay(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDropDay(null)
            const drag = dragged.current
            dragged.current = null
            if (!drag) return
            const delta = daysBetween(drag.from, week[dayUnder(e, e.currentTarget, week.length)]!)
            if (delta) onMoveDays(drag.occ, delta)
          }}
        >
          {week.map((day, c) => {
            const key = dayKey(day)
            const inMonth = day.getMonth() === month
            return (
              <div
                key={key}
                data-testid={`month-day-${key}`}
                onClick={() => onDayClick(day)}
                style={{ gridColumn: c + 1, gridRow: '1 / -1' }}
                className={`cursor-pointer border-r border-b border-line transition-colors hover:bg-surface-2/50 ${inMonth ? '' : 'bg-surface-2/30'} ${dropDay === key ? 'bg-accent-wash ring-1 ring-accent ring-inset' : ''}`}
              />
            )
          })}
          {week.map((day, c) => {
            const key = dayKey(day)
            return (
              <span
                key={key}
                style={{ gridColumn: c + 1, gridRow: 1 }}
                className={`pointer-events-none mx-1 mt-1 mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${key === today ? 'bg-accent font-semibold text-accent-ink shadow-raised' : day.getMonth() === month ? '' : 'text-ink-subtle'}`}
              >
                {day.getDate()}
              </span>
            )
          })}
          {bars
            .filter((b) => b.lane < MAX_LINES)
            .map((b) =>
              item(
                b.occ,
                `${b.occ.eventId}-${b.occ.recurrenceId ?? ''}`,
                // A bar may be picked up by any of its days; the move is
                // measured from that one, so it lands where it is let go.
                (e) => week[dayUnder(e, e.currentTarget.parentElement!, week.length)]!,
                `${b.continuesBefore ? '' : 'ml-1'} ${b.continuesAfter ? '' : 'mr-1'} mb-px ${barEnds(b.continuesBefore, b.continuesAfter)}`,
                { gridColumn: `${b.first + 1} / ${b.last + 2}`, gridRow: b.lane + 2 },
                !b.occ.allDay && !b.continuesBefore,
              ),
            )}
          {week.map((day, c) => {
            const list = singles.get(dayKey(day)) ?? []
            const room = Math.max(0, MAX_LINES - lanes[c]!)
            const hidden =
              bars.filter((b) => b.lane >= MAX_LINES && b.first <= c && c <= b.last).length +
              Math.max(0, list.length - room)
            return [
              ...list
                .slice(0, room)
                .map((s, i) =>
                  item(
                    s.occ,
                    `${s.occ.eventId}-${s.occ.recurrenceId ?? ''}`,
                    () => day,
                    'mx-1 mb-px rounded',
                    { gridColumn: c + 1, gridRow: lanes[c]! + i + 2 },
                    true,
                  ),
                ),
              hidden > 0 && (
                <span
                  key={`more-${dayKey(day)}`}
                  style={{ gridColumn: c + 1, gridRow: MAX_LINES + 2 }}
                  className="pointer-events-none mx-1 text-[10px] text-ink-muted"
                >
                  +{hidden}
                </span>
              ),
            ]
          })}
        </div>
      ))}
    </div>
  )
}
