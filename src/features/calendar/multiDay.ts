import type { Occurrence } from '../../domain/calendar'
import { dayKey } from '../../lib/dates'

/**
 * Laying out occurrences that run across more than one day.
 *
 * Every view is a row of local days. An occurrence is on each day it overlaps,
 * not just the one it starts on, and one that began before the first day on
 * screen is still on screen. Days are local midnight to local midnight, so
 * one is 23 or 25 hours long across a DST change.
 */

/** A day's local midnight, and the next one. */
export function dayBounds(day: Date): [Date, Date] {
  const y = day.getFullYear()
  const m = day.getMonth()
  const d = day.getDate()
  return [new Date(y, m, d), new Date(y, m, d + 1)]
}

/** On the day: it overlaps it, or, taking no time at all, starts in it. */
function onDay(occ: Occurrence, from: Date, to: Date): boolean {
  if (occ.end <= occ.start) return occ.start >= from && occ.start < to
  return occ.start < to && occ.end > from
}

/** Whether the occurrence is on more than one local day. */
export function spansDays(occ: Occurrence): boolean {
  const lastInstant = occ.end > occ.start ? new Date(occ.end.getTime() - 1) : occ.start
  return dayKey(occ.start) !== dayKey(lastInstant)
}

/**
 * Drawn as a bar in the week view's all-day row rather than as a block in the
 * time grid: an all-day event, or a timed one lasting a day or more.
 */
export function isBanner(occ: Occurrence): boolean {
  return occ.allDay || occ.end.getTime() - occ.start.getTime() >= 86_400_000
}

/** One day's share of an occurrence. */
export interface Segment {
  occ: Occurrence
  /** The occurrence clipped to the day. */
  start: Date
  end: Date
  /** It began on an earlier day, or runs on into a later one. */
  continuesBefore: boolean
  continuesAfter: boolean
}

/** Every day's share of the occurrences, keyed by `dayKey`, in start order. */
export function segmentsByDay(occs: Occurrence[], days: Date[]): Map<string, Segment[]> {
  const sorted = [...occs].sort((a, b) => a.start.getTime() - b.start.getTime())
  const map = new Map<string, Segment[]>()
  for (const day of days) {
    const [from, to] = dayBounds(day)
    const list: Segment[] = []
    for (const occ of sorted) {
      if (!onDay(occ, from, to)) continue
      list.push({
        occ,
        start: occ.start < from ? from : occ.start,
        end: occ.end > to ? to : occ.end,
        continuesBefore: occ.start < from,
        continuesAfter: occ.end > to,
      })
    }
    if (list.length) map.set(dayKey(day), list)
  }
  return map
}

/** An occurrence as a bar across a row of days. */
export interface Bar {
  occ: Occurrence
  /** The first and last of the row's days it covers, as indexes. */
  first: number
  last: number
  /** Which line of the row it is drawn on, from 0. */
  lane: number
  /** It carries on beyond the row's first or last day. */
  continuesBefore: boolean
  continuesAfter: boolean
}

/**
 * Bars for the occurrences across a row of consecutive days, each on the
 * lowest lane free for all its days. Those starting earlier go first, and of
 * those the longer, so long events keep to the top lanes as the rows go by.
 */
export function layoutBars(occs: Occurrence[], days: Date[]): Bar[] {
  const bounds = days.map(dayBounds)
  const placed: Omit<Bar, 'lane'>[] = []
  for (const occ of occs) {
    let first = -1
    let last = -1
    bounds.forEach(([from, to], i) => {
      if (!onDay(occ, from, to)) return
      if (first < 0) first = i
      last = i
    })
    if (first < 0) continue
    placed.push({
      occ,
      first,
      last,
      continuesBefore: occ.start < bounds[first]![0],
      continuesAfter: occ.end > bounds[last]![1],
    })
  }
  placed.sort(
    (a, b) =>
      a.first - b.first ||
      b.last - a.last ||
      a.occ.start.getTime() - b.occ.start.getTime() ||
      a.occ.eventId.localeCompare(b.occ.eventId),
  )
  const lanes: Bar[][] = []
  const out: Bar[] = []
  for (const p of placed) {
    let lane = 0
    while (lanes[lane]?.some((b) => b.first <= p.last && p.first <= b.last)) lane++
    const bar = { ...p, lane }
    ;(lanes[lane] ??= []).push(bar)
    out.push(bar)
  }
  return out
}

/** How many lanes are taken on each of the row's days: the lowest one free. */
export function lanesInUse(bars: Bar[], dayCount: number): number[] {
  const used = Array.from({ length: dayCount }, () => 0)
  for (const b of bars)
    for (let i = b.first; i <= b.last; i++) used[i] = Math.max(used[i]!, b.lane + 1)
  return used
}

/** The same wall-clock time `days` days later (or earlier), whatever DST does. */
export function shiftDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/** Whole local days from `a` to `b`. */
export function daysBetween(a: Date, b: Date): number {
  const [da] = dayBounds(a)
  const [db] = dayBounds(b)
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

/** Square ends on a bar where it carries on past the days it is drawn over. */
export function barEnds(continuesBefore: boolean, continuesAfter: boolean): string {
  return `${continuesBefore ? 'rounded-l-none' : 'rounded-l'} ${continuesAfter ? 'rounded-r-none' : 'rounded-r'}`
}
