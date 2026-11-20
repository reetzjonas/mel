import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent, Occurrence } from '../../domain/calendar'
import { dayKey } from '../../lib/dates'
import { currentLocale } from '../../lib/i18n'
import { instantAt, isMoved, placementFor, type DragMode, type DragOrigin } from './dragGeometry'
import { barEnds, isBanner, layoutBars, segmentsByDay, type Segment } from './multiDay'

const HOUR_HEIGHT = 48 // px
/** The hour gutter; must match the `w-12` column that draws it. */
const GUTTER_PX = 48
/** How far the pointer travels before this is a drag and not a click. */
const DRAG_THRESHOLD_PX = 4

interface Drag extends DragOrigin {
  /** Which block on screen, so only that one previews. */
  key: string
  occ: Occurrence
  originX: number
  originY: number
  deltaMinutes: number
  deltaDays: number
  past: boolean
}

const hourLabelFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })
const dayHeaderFmt = new Intl.DateTimeFormat(currentLocale, { weekday: 'short', day: 'numeric' })

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

type Positioned = Segment & {
  col: number
  cols: number
}

/** Greedy overlap layout: side-by-side columns for events that collide. */
function layoutDay(occs: Segment[]): Positioned[] {
  const sorted = [...occs].sort((a, b) => a.start.getTime() - b.start.getTime())
  const out: Positioned[] = []
  let cluster: Positioned[] = []
  let clusterEnd = -Infinity
  const active: { col: number; end: number }[] = []

  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1))
    for (const c of cluster) c.cols = cols
    out.push(...cluster)
    cluster = []
    active.length = 0
  }

  for (const occ of sorted) {
    if (occ.start.getTime() >= clusterEnd && cluster.length) flush()
    let col = 0
    while (active.some((a) => a.col === col && a.end > occ.start.getTime())) col++
    active.push({ col, end: occ.end.getTime() })
    clusterEnd = Math.max(clusterEnd, occ.end.getTime())
    cluster.push({ ...occ, col, cols: 1 })
  }
  flush()
  return out
}

export function TimeGrid({
  days,
  occurrences,
  eventFor,
  calendarColor,
  onSlotClick,
  onEventClick,
  onEventDrop,
  canMove,
  today,
}: {
  days: Date[]
  /** Every occurrence on screen, however many of the days it is on. */
  occurrences: Occurrence[]
  /** The event as this occurrence stands, which for a series is not the series. */
  eventFor: (occ: Occurrence) => CalendarEvent | undefined
  calendarColor: (event: CalendarEvent) => string | null
  onSlotClick: (day: Date, minutes: number) => void
  onEventClick: (occ: Occurrence) => void
  /** A block dragged to a new time; the instants are in the viewer's zone. */
  onEventDrop: (occ: Occurrence, start: Date, end: Date) => void
  /** Which events may be dragged at all — birthdays and invitations may not. */
  canMove: (event: CalendarEvent) => boolean
  today: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnsRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  /* The handlers read the drag from here, not from `drag`. React treats
     pointermove as a continuous event and does not flush its setState before
     the next discrete one, so under load a pointerup can arrive while the
     closure still holds the drag from before the last moves — `past` still
     false — and the gesture is thrown away as a click. The ref is written in
     the same breath as the state and so is never behind. */
  const dragRef = useRef<Drag | null>(null)
  function updateDrag(next: Drag | null) {
    dragRef.current = next
    setDrag(next)
  }
  /* A completed drag is followed by a click on the same element; without this
     the block would also open the dialog the moment it was dropped. */
  const draggedRef = useRef(false)

  const placement = drag ? placementFor(drag, drag.deltaMinutes, drag.deltaDays, days.length) : null

  function beginDrag(e: React.PointerEvent, mode: DragMode, origin: Drag) {
    // Touch keeps tap-to-open: a drag here would fight the grid's own
    // scrolling, and the dialog is the way in on a phone anyway.
    if (e.pointerType === 'touch' || e.button !== 0) return
    /* Claimed on pointerdown, or the browser starts selecting text on the
       first move and abandons the sequence with a pointercancel — the same
       trap the panel handles hit (docs/notes/panel-widths.md). */
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    updateDrag({ ...origin, mode })
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    const dy = e.clientY - drag.originY
    const dx = e.clientX - drag.originX
    const past = drag.past || Math.abs(dy) > DRAG_THRESHOLD_PX || Math.abs(dx) > DRAG_THRESHOLD_PX
    if (!past) return
    const rect = columnsRef.current?.getBoundingClientRect()
    const dayWidth = rect ? (rect.width - GUTTER_PX) / days.length : 0
    updateDrag({
      ...drag,
      past,
      deltaMinutes: (dy / HOUR_HEIGHT) * 60,
      deltaDays: drag.mode === 'move' && dayWidth > 0 ? Math.round(dx / dayWidth) : 0,
    })
  }

  function endDrag(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    const target = placementFor(drag, drag.deltaMinutes, drag.deltaDays, days.length)
    if (drag.past && isMoved(drag, target)) {
      draggedRef.current = true
      const day = days[target.dayIndex]!
      onEventDrop(drag.occ, instantAt(day, target.startMinutes), instantAt(day, target.endMinutes))
    }
    updateDrag(null)
  }

  useEffect(() => {
    // Land on ~7am on first render so the working day is in view.
    scrollRef.current?.scrollTo({ top: 7 * HOUR_HEIGHT })
  }, [])

  /* All-day events, and timed ones of a day or more, are bars across the
     all-day row; the rest are blocks in the time grid, one per day they are on,
     so one past midnight carries on at the top of the next day. */
  const bars = useMemo(() => layoutBars(occurrences.filter(isBanner), days), [occurrences, days])
  const timedByDay = useMemo(
    () =>
      segmentsByDay(
        occurrences.filter((o) => !isBanner(o)),
        days,
      ),
    [occurrences, days],
  )

  const now = new Date()
  const nowTop = (minutesOfDay(now) / 60) * HOUR_HEIGHT

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex border-b border-line">
        <div className="w-12 shrink-0" />
        {days.map((d) => (
          <div
            key={dayKey(d)}
            className={`flex-1 border-l border-line py-1.5 text-center text-[11px] font-semibold tracking-wide uppercase ${
              dayKey(d) === today ? 'text-accent' : 'text-ink-subtle'
            }`}
          >
            <span className="capitalize">{dayHeaderFmt.format(d)}</span>
          </div>
        ))}
      </div>
      {/* All-day row */}
      <div className="flex border-b border-line">
        <div className="w-12 shrink-0" />
        <div className="relative min-h-[1.5rem] flex-1">
          <div aria-hidden className="absolute inset-0 flex">
            {days.map((d) => (
              <div key={dayKey(d)} className="flex-1 border-l border-line" />
            ))}
          </div>
          <div
            data-testid="all-day-row"
            className="relative grid auto-rows-[1rem] gap-y-0.5 px-px py-0.5"
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {bars.map((b) => {
              const ev = eventFor(b.occ)
              const color = ev ? calendarColor(ev) : null
              return (
                <button
                  key={`${b.occ.eventId}-${b.occ.recurrenceId ?? ''}`}
                  type="button"
                  onClick={() => onEventClick(b.occ)}
                  style={{
                    gridColumn: `${b.first + 1} / ${b.last + 2}`,
                    gridRow: b.lane + 1,
                    ...(color ? { backgroundColor: `${color}26`, color } : {}),
                  }}
                  className={`mx-0.5 truncate px-1 text-left text-[11px] leading-4 transition-opacity hover:opacity-80 ${barEnds(b.continuesBefore, b.continuesAfter)} ${!color ? 'bg-accent-wash text-accent' : ''}`}
                >
                  {!b.occ.allDay && !b.continuesBefore && (
                    <span className="tabular-nums">{timeFmt.format(b.occ.start)} </span>
                  )}
                  {ev?.title || '—'}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div ref={columnsRef} className="relative flex">
          <div className="w-12 shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                style={{ height: HOUR_HEIGHT }}
                className="border-b border-line pr-1.5 text-right text-[10px] text-ink-subtle"
              >
                {h === 0 ? '' : hourLabelFmt.format(new Date(2000, 0, 1, h))}
              </div>
            ))}
          </div>
          {days.map((d, dayIndex) => {
            const key = dayKey(d)
            const positioned = layoutDay(timedByDay.get(key) ?? [])
            return (
              <div key={key} className="relative flex-1 border-l border-line">
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    data-testid={`slot-${key}-${h}`}
                    style={{ height: HOUR_HEIGHT }}
                    className="cursor-pointer border-b border-line hover:bg-surface-2/60"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const frac = (e.clientY - rect.top) / rect.height
                      // Clamp so rounding near the bottom of the 23:00 slot
                      // can't overflow into the next day.
                      const minutes = Math.min(
                        23 * 60 + 30,
                        h * 60 + Math.round((frac * 60) / 30) * 30,
                      )
                      onSlotClick(d, minutes)
                    }}
                  />
                ))}
                {key === today && (
                  <div
                    className="pointer-events-none absolute right-0 left-0 z-10 border-t-2 border-danger"
                    style={{ top: nowTop }}
                  />
                )}
                {positioned.map((seg, i) => {
                  const o = seg.occ
                  const ev = eventFor(o)
                  const color = ev ? calendarColor(ev) : null
                  const blockKey = `${key}-${o.eventId}-${i}`
                  const startMinutes = minutesOfDay(seg.start)
                  const endMinutes = seg.continuesAfter
                    ? 24 * 60
                    : startMinutes + Math.round((seg.end.getTime() - seg.start.getTime()) / 60_000)
                  /* A block that is only part of its event, the rest being on
                     the day before or after, stays put: dragging it would have
                     to say what becomes of the rest. */
                  const split = seg.continuesBefore || seg.continuesAfter
                  const movable = Boolean(ev) && canMove(ev!) && !split
                  const dragging = drag?.key === blockKey && drag.past
                  const shown =
                    dragging && placement ? placement : { dayIndex, startMinutes, endMinutes }
                  const top = (shown.startMinutes / 60) * HOUR_HEIGHT
                  const height = Math.max(
                    18,
                    ((shown.endMinutes - shown.startMinutes) / 60) * HOUR_HEIGHT,
                  )
                  const width = 100 / seg.cols
                  // A block being dragged leaves its column's stacking and
                  // spans the day it is heading for, so it can cross columns.
                  const offColumn = dragging && shown.dayIndex !== dayIndex
                  const origin = {
                    key: blockKey,
                    occ: o,
                    mode: 'move' as DragMode,
                    dayIndex,
                    startMinutes,
                    endMinutes,
                    originX: 0,
                    originY: 0,
                    deltaMinutes: 0,
                    deltaDays: 0,
                    past: false,
                  }
                  const grab = (e: React.PointerEvent, mode: DragMode) =>
                    beginDrag(e, mode, {
                      ...origin,
                      originX: e.clientX,
                      originY: e.clientY,
                    })
                  return (
                    <button
                      key={blockKey}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (draggedRef.current) {
                          draggedRef.current = false
                          return
                        }
                        onEventClick(o)
                      }}
                      onPointerDown={movable ? (e) => grab(e, 'move') : undefined}
                      onPointerMove={movable ? onPointerMove : undefined}
                      onPointerUp={movable ? endDrag : undefined}
                      // A cancelled drag is thrown away rather than committed:
                      // unlike a panel width, this one writes to the server.
                      onPointerCancel={movable ? () => updateDrag(null) : undefined}
                      style={{
                        top,
                        height,
                        left: offColumn
                          ? `calc(${(shown.dayIndex - dayIndex) * 100}% + ${seg.col * width}%)`
                          : `${seg.col * width}%`,
                        width: `calc(${width}% - 2px)`,
                        ...(color
                          ? { backgroundColor: `${color}26`, color, borderColor: color }
                          : {}),
                      }}
                      className={`absolute overflow-hidden rounded-md border px-1.5 ${seg.continuesBefore ? 'rounded-t-none border-t-0' : ''} ${seg.continuesAfter ? 'rounded-b-none border-b-0' : ''} py-0.5 text-left text-[11px] leading-tight shadow-raised ${
                        dragging
                          ? 'z-20 cursor-grabbing opacity-90 shadow-overlay'
                          : `z-[5] transition-transform hover:scale-[1.01] ${movable ? 'cursor-grab' : 'cursor-pointer'}`
                      } ${!color ? 'border-accent/30 bg-accent-wash text-accent' : ''}`}
                    >
                      <span className="font-medium">{ev?.title || '—'}</span>
                      {/* Both ends, not just the start: the block's height is
                          the only other clue to how long it runs, and reading
                          a length off a rectangle is guesswork. */}
                      <span className="block opacity-80">
                        {dragging
                          ? `${timeFmt.format(instantAt(d, shown.startMinutes))} – ${timeFmt.format(instantAt(d, shown.endMinutes))}`
                          : `${timeFmt.format(o.start)} – ${timeFmt.format(o.end)}`}
                      </span>
                      {movable && (
                        <>
                          {/* Edge strips rather than visible handles: a block
                              can be twenty pixels tall, and two dots would
                              then be most of the event. */}
                          <span
                            aria-hidden
                            onPointerDown={(e) => grab(e, 'resize-start')}
                            onPointerMove={onPointerMove}
                            onPointerUp={endDrag}
                            onPointerCancel={() => updateDrag(null)}
                            className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize"
                          />
                          <span
                            aria-hidden
                            onPointerDown={(e) => grab(e, 'resize-end')}
                            onPointerMove={onPointerMove}
                            onPointerUp={endDrag}
                            onPointerCancel={() => updateDrag(null)}
                            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                          />
                        </>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
