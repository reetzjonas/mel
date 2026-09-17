/**
 * What a drag on the week/day grid means, in wall-clock minutes.
 *
 * Pure on purpose: the grid is pixels and pointer events, this is the part
 * that decides where an event lands, and the awkward cases — snapping, the
 * edges of the day, a block dragged so it would turn inside out — are all
 * here rather than tangled into a pointer handler.
 */

/** Minutes a drag settles onto; the quarter hour most calendars agree on. */
export const SNAP_MINUTES = 15

/** Shortest event a resize may leave behind. */
const MIN_MINUTES = 15

const DAY_MINUTES = 24 * 60

export type DragMode = 'move' | 'resize-start' | 'resize-end'

export interface DragOrigin {
  mode: DragMode
  /** Column the block started in; 0 in the day view. */
  dayIndex: number
  startMinutes: number
  endMinutes: number
}

export interface DragPlacement {
  dayIndex: number
  startMinutes: number
  endMinutes: number
}

const snap = (m: number) => Math.round(m / SNAP_MINUTES) * SNAP_MINUTES
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Where the block sits for a drag of this much, ready to draw or to commit.
 *
 * A move keeps the event's length and never spills past midnight: dragging a
 * two-hour meeting to the bottom of the day parks it at 22:00, rather than
 * silently shortening it or landing half in tomorrow — which the grid has no
 * way to draw and the day column no way to hold.
 */
export function placementFor(
  origin: DragOrigin,
  deltaMinutes: number,
  deltaDays: number,
  dayCount: number,
): DragPlacement {
  if (origin.mode === 'move') {
    const span = origin.endMinutes - origin.startMinutes
    const startMinutes = clamp(snap(origin.startMinutes + deltaMinutes), 0, DAY_MINUTES - span)
    return {
      dayIndex: clamp(origin.dayIndex + deltaDays, 0, dayCount - 1),
      startMinutes,
      endMinutes: startMinutes + span,
    }
  }

  // A resize stays in its column: the grid draws one block per day, so a
  // bottom edge dragged sideways has nowhere to go.
  if (origin.mode === 'resize-end') {
    return {
      dayIndex: origin.dayIndex,
      startMinutes: origin.startMinutes,
      endMinutes: clamp(
        snap(origin.endMinutes + deltaMinutes),
        origin.startMinutes + MIN_MINUTES,
        DAY_MINUTES,
      ),
    }
  }

  return {
    dayIndex: origin.dayIndex,
    startMinutes: clamp(
      snap(origin.startMinutes + deltaMinutes),
      0,
      origin.endMinutes - MIN_MINUTES,
    ),
    endMinutes: origin.endMinutes,
  }
}

/** Whether the drag actually changed anything worth writing to the server. */
export function isMoved(origin: DragOrigin, placement: DragPlacement): boolean {
  return (
    placement.dayIndex !== origin.dayIndex ||
    placement.startMinutes !== origin.startMinutes ||
    placement.endMinutes !== origin.endMinutes
  )
}

/**
 * The instant a column and a minute-of-day stand for, in the viewer's zone.
 *
 * Built from calendar fields rather than by adding milliseconds: a day is not
 * always 86,400,000 ms long, and dragging an event across the end of summer
 * time by adding a day's worth of milliseconds lands it an hour out.
 */
export function instantAt(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes, 0, 0)
}
