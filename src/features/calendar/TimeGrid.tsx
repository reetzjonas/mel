import { useEffect, useRef } from 'react'
import type { CalendarEvent, Occurrence } from '../../domain/calendar'
import { currentLocale } from '../../lib/i18n'

const HOUR_HEIGHT = 48 // px

const hourLabelFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })
const dayHeaderFmt = new Intl.DateTimeFormat(currentLocale, { weekday: 'short', day: 'numeric' })

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

interface Positioned extends Occurrence {
  col: number
  cols: number
}

/** Greedy overlap layout: side-by-side columns for events that collide. */
function layoutDay(occs: Occurrence[]): Positioned[] {
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
  eventsByDay,
  eventById,
  calendarColor,
  onSlotClick,
  onEventClick,
  today,
}: {
  days: Date[]
  eventsByDay: Map<string, Occurrence[]>
  eventById: Map<string, CalendarEvent>
  calendarColor: (event: CalendarEvent) => string | null
  onSlotClick: (day: Date, minutes: number) => void
  onEventClick: (eventId: string) => void
  today: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Land on ~7am on first render so the working day is in view.
    scrollRef.current?.scrollTo({ top: 7 * HOUR_HEIGHT })
  }, [])

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
        {days.map((d) => {
          const allDay = (eventsByDay.get(dayKey(d)) ?? []).filter((o) => o.allDay)
          return (
            <div key={dayKey(d)} className="min-h-[1.5rem] flex-1 space-y-0.5 border-l border-line p-0.5">
              {allDay.map((o, i) => {
                const ev = eventById.get(o.eventId)
                const color = ev ? calendarColor(ev) : null
                return (
                  <button
                    key={`${o.eventId}-${i}`}
                    type="button"
                    onClick={() => onEventClick(o.eventId)}
                    style={color ? { backgroundColor: `${color}26`, color } : undefined}
                    className={`block w-full truncate rounded px-1 text-left text-[11px] leading-4 transition-opacity hover:opacity-80 ${!color ? 'bg-accent-wash text-accent' : ''}`}
                  >
                    {ev?.title || '—'}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex">
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
          {days.map((d) => {
            const key = dayKey(d)
            const timed = (eventsByDay.get(key) ?? []).filter((o) => !o.allDay)
            const positioned = layoutDay(timed)
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
                      const minutes = Math.min(23 * 60 + 30, h * 60 + Math.round((frac * 60) / 30) * 30)
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
                {positioned.map((o, i) => {
                  const ev = eventById.get(o.eventId)
                  const color = ev ? calendarColor(ev) : null
                  const top = (minutesOfDay(o.start) / 60) * HOUR_HEIGHT
                  const height = Math.max(
                    18,
                    ((o.end.getTime() - o.start.getTime()) / 60_000 / 60) * HOUR_HEIGHT,
                  )
                  const width = 100 / o.cols
                  return (
                    <button
                      key={`${o.eventId}-${i}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEventClick(o.eventId)
                      }}
                      style={{
                        top,
                        height,
                        left: `${o.col * width}%`,
                        width: `calc(${width}% - 2px)`,
                        ...(color
                          ? { backgroundColor: `${color}26`, color, borderColor: color }
                          : {}),
                      }}
                      className={`absolute z-[5] overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-raised transition-transform hover:scale-[1.01] ${!color ? 'border-accent/30 bg-accent-wash text-accent' : ''}`}
                    >
                      <span className="font-medium">{ev?.title || '—'}</span>
                      <span className="block opacity-80">{timeFmt.format(o.start)}</span>
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
