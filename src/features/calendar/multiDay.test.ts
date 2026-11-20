import { describe, expect, it } from 'vitest'
import type { Occurrence } from '../../domain/calendar'
import {
  daysBetween,
  isBanner,
  lanesInUse,
  layoutBars,
  segmentsByDay,
  shiftDays,
  spansDays,
} from './multiDay'

// Local times throughout, so these hold in whatever zone the tests run in.
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m)
const occ = (id: string, start: Date, end: Date, allDay = false): Occurrence => ({
  eventId: id,
  recurrenceId: null,
  start,
  end,
  allDay,
})
/** Mon 14 – Sun 20 September 2026. */
const week = Array.from({ length: 7 }, (_, i) => at(14 + i))

describe('which days an occurrence is on', () => {
  it('puts one on every day it overlaps, clipped to each', () => {
    const trip = occ('trip', at(15, 18), at(17, 9))
    const map = segmentsByDay([trip], week)
    expect([...map.keys()]).toEqual(['2026-09-15', '2026-09-16', '2026-09-17'])
    const [tue, wed, thu] = [...map.values()].map((l) => l[0]!)
    expect(tue).toMatchObject({
      start: at(15, 18),
      end: at(16),
      continuesBefore: false,
      continuesAfter: true,
    })
    expect(wed).toMatchObject({
      start: at(16),
      end: at(17),
      continuesBefore: true,
      continuesAfter: true,
    })
    expect(thu).toMatchObject({
      start: at(17),
      end: at(17, 9),
      continuesBefore: true,
      continuesAfter: false,
    })
  })

  it('shows one that began before the first day on screen', () => {
    const map = segmentsByDay([occ('long', at(10), at(16), true)], week)
    expect([...map.keys()]).toEqual(['2026-09-14', '2026-09-15'])
    expect(map.get('2026-09-14')![0]!.continuesBefore).toBe(true)
  })

  it('does not put one ending at midnight on the next day', () => {
    const map = segmentsByDay([occ('allday', at(15), at(16), true)], week)
    expect([...map.keys()]).toEqual(['2026-09-15'])
    expect(spansDays(occ('allday', at(15), at(16), true))).toBe(false)
  })

  it('keeps one taking no time on the day it is at', () => {
    const map = segmentsByDay([occ('reminder', at(15, 9), at(15, 9))], week)
    expect([...map.keys()]).toEqual(['2026-09-15'])
  })

  it('lists each day in start order', () => {
    const late = occ('late', at(15, 14), at(15, 15))
    const early = occ('early', at(15, 8), at(15, 9))
    const overnight = occ('overnight', at(14, 22), at(15, 2))
    expect(
      segmentsByDay([late, early, overnight], week)
        .get('2026-09-15')!
        .map((s) => s.occ.eventId),
    ).toEqual(['overnight', 'early', 'late'])
  })
})

describe('what is drawn as a bar', () => {
  it('is an all-day event, or a timed one of a day or more', () => {
    expect(isBanner(occ('a', at(15), at(16), true))).toBe(true)
    expect(isBanner(occ('b', at(15, 10), at(16, 10)))).toBe(true)
    expect(isBanner(occ('c', at(15, 22), at(16, 2)))).toBe(false)
    expect(spansDays(occ('c', at(15, 22), at(16, 2)))).toBe(true)
  })
})

describe('bars across a row of days', () => {
  it('spans the days covered and says where it carries on', () => {
    const [bar] = layoutBars([occ('conf', at(12), at(16), true)], week)
    expect(bar).toMatchObject({
      first: 0,
      last: 1,
      lane: 0,
      continuesBefore: true,
      continuesAfter: false,
    })
    const [next] = layoutBars([occ('hols', at(19), at(25), true)], week)
    expect(next).toMatchObject({ first: 5, last: 6, continuesBefore: false, continuesAfter: true })
  })

  it('puts overlapping bars on separate lanes and reuses a free one', () => {
    const bars = layoutBars(
      [
        occ('short', at(15), at(16), true),
        occ('long', at(15), at(18), true),
        occ('later', at(18), at(20), true),
      ],
      week,
    )
    const lane = Object.fromEntries(bars.map((b) => [b.occ.eventId, b.lane]))
    // The longer of two starting the same day takes the top lane.
    expect(lane).toEqual({ long: 0, short: 1, later: 0 })
    expect(lanesInUse(bars, 7)).toEqual([0, 2, 1, 1, 1, 1, 0])
  })

  it('leaves out what is not in the row', () => {
    expect(layoutBars([occ('gone', at(1), at(3), true)], week)).toEqual([])
  })
})

describe('moving by whole days', () => {
  it('keeps the wall-clock time', () => {
    expect(shiftDays(at(15, 10, 30), 3)).toEqual(at(18, 10, 30))
    expect(shiftDays(at(15, 10, 30), -15)).toEqual(new Date(2026, 7, 31, 10, 30))
  })

  it('counts local days, not 24-hour stretches', () => {
    expect(daysBetween(at(15, 23), at(16, 1))).toBe(1)
    expect(daysBetween(at(16, 1), at(15, 23))).toBe(-1)
    expect(daysBetween(at(15), new Date(2026, 11, 25))).toBe(101)
  })
})
