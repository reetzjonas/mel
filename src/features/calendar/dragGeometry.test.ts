import { describe, expect, it } from 'vitest'
import { instantAt, isMoved, placementFor, type DragOrigin } from './dragGeometry'

const origin = (over: Partial<DragOrigin> = {}): DragOrigin => ({
  mode: 'move',
  dayIndex: 2,
  startMinutes: 10 * 60,
  endMinutes: 11 * 60,
  ...over,
})

describe('moving a block', () => {
  it('snaps to the quarter hour', () => {
    // Halfway to the next quarter is where it tips over.
    expect(placementFor(origin(), 8, 0, 7).startMinutes).toBe(10 * 60 + 15)
    expect(placementFor(origin(), 7, 0, 7).startMinutes).toBe(10 * 60)
  })

  it('keeps the event as long as it was', () => {
    const p = placementFor(origin({ endMinutes: 11 * 60 + 30 }), 120, 0, 7)

    expect(p.endMinutes - p.startMinutes).toBe(90)
  })

  it('parks at the end of the day rather than spilling into tomorrow', () => {
    /*
     * The column has nowhere to draw the overflow and the day has nowhere to
     * hold it, so a two-hour meeting dragged to the bottom stops at 22:00 —
     * rather than being silently shortened to fit.
     */
    const p = placementFor(origin({ startMinutes: 22 * 60, endMinutes: 24 * 60 }), 600, 0, 7)

    expect(p.startMinutes).toBe(22 * 60)
    expect(p.endMinutes).toBe(24 * 60)
  })

  it('cannot be dragged off either end of the week', () => {
    expect(placementFor(origin(), 0, -9, 7).dayIndex).toBe(0)
    expect(placementFor(origin(), 0, 9, 7).dayIndex).toBe(6)
  })

  it('moves columns in the week view', () => {
    expect(placementFor(origin(), 0, 2, 7).dayIndex).toBe(4)
  })
})

describe('resizing a block', () => {
  it('drags the bottom edge without moving the start', () => {
    const p = placementFor(origin({ mode: 'resize-end' }), 60, 0, 7)

    expect(p.startMinutes).toBe(10 * 60)
    expect(p.endMinutes).toBe(12 * 60)
  })

  it('drags the top edge without moving the end', () => {
    const p = placementFor(origin({ mode: 'resize-start' }), -60, 0, 7)

    expect(p.startMinutes).toBe(9 * 60)
    expect(p.endMinutes).toBe(11 * 60)
  })

  it('never turns the block inside out', () => {
    // Dragging the bottom edge above the top would otherwise store an event
    // that ends before it starts, which nothing downstream can draw.
    const up = placementFor(origin({ mode: 'resize-end' }), -600, 0, 7)
    expect(up.endMinutes).toBe(up.startMinutes + 15)

    const down = placementFor(origin({ mode: 'resize-start' }), 600, 0, 7)
    expect(down.startMinutes).toBe(down.endMinutes - 15)
  })

  it('stays in its own column, however far sideways the pointer goes', () => {
    // One block per day is drawn, so a bottom edge has nowhere else to be.
    expect(placementFor(origin({ mode: 'resize-end' }), 0, 3, 7).dayIndex).toBe(2)
  })
})

describe('whether anything actually changed', () => {
  it('says no for a drag that snapped back to where it started', () => {
    const o = origin()

    expect(isMoved(o, placementFor(o, 3, 0, 7))).toBe(false)
  })

  it('says yes once the block has left its slot', () => {
    const o = origin()

    expect(isMoved(o, placementFor(o, 30, 0, 7))).toBe(true)
    expect(isMoved(o, placementFor(o, 0, 1, 7))).toBe(true)
  })
})

describe('instantAt', () => {
  it('builds the time from calendar fields, not by adding milliseconds', () => {
    /*
     * A day is not always 86,400,000 ms long. Dragging an event across the end
     * of summer time by adding a day's worth of milliseconds lands it an hour
     * out; asking for "that date at that minute" cannot.
     */
    const d = instantAt(new Date(2026, 9, 25), 10 * 60 + 30)

    expect(d.getHours()).toBe(10)
    expect(d.getMinutes()).toBe(30)
    expect(d.getDate()).toBe(25)
  })
})
