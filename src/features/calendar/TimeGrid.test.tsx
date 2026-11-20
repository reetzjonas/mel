import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CalendarEvent, Occurrence } from '../../domain/calendar'
import { dayKey } from '../../lib/dates'
import { TimeGrid } from './TimeGrid'

const day = new Date(2026, 8, 16)
const occ: Occurrence = {
  eventId: 'e1',
  recurrenceId: null,
  start: new Date(2026, 8, 16, 10, 0),
  end: new Date(2026, 8, 16, 11, 0),
  allDay: false,
}

function renderGrid(onEventDrop: (o: Occurrence, s: Date, e: Date) => void) {
  render(
    <TimeGrid
      days={[day]}
      occurrences={[occ]}
      eventFor={() => ({ id: 'e1', title: 'Standup' }) as unknown as CalendarEvent}
      calendarColor={() => null}
      onSlotClick={() => {}}
      onEventClick={() => {}}
      onEventDrop={onEventDrop}
      canMove={() => true}
      today={dayKey(day)}
    />,
  )
  return screen.getByRole('button', { name: /Standup/ })
}

describe('dragging a block in the time grid', () => {
  afterEach(cleanup)

  // jsdom has neither pointer capture nor element scrolling.
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollTo ??= () => {}

  it('commits a drag whose moves have not been rendered yet when the button comes up', () => {
    /*
     * Everything inside one act(): React does not flush the setState of a
     * pointermove before the pointerup that follows it, which is what a loaded
     * browser does to a real gesture. A handler reading the drag from its
     * render closure sees the state from before the moves and reads the gesture
     * as a click.
     */
    const onEventDrop = vi.fn()
    const block = renderGrid(onEventDrop)
    act(() => {
      fireEvent.pointerDown(block, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(block, { clientX: 100, clientY: 124, pointerId: 1 })
      fireEvent.pointerMove(block, { clientX: 100, clientY: 148, pointerId: 1 })
      fireEvent.pointerUp(block, { clientX: 100, clientY: 148, pointerId: 1 })
    })
    expect(onEventDrop).toHaveBeenCalledTimes(1)
    const [, start] = onEventDrop.mock.calls[0]!
    // 48px is one hour at 48px per hour.
    expect(start).toEqual(new Date(2026, 8, 16, 11, 0))
  })

  it('leaves a press that never travelled to the click', () => {
    const onEventDrop = vi.fn()
    const block = renderGrid(onEventDrop)
    act(() => {
      fireEvent.pointerDown(block, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(block, { clientX: 101, clientY: 102, pointerId: 1 })
      fireEvent.pointerUp(block, { clientX: 101, clientY: 102, pointerId: 1 })
    })
    expect(onEventDrop).not.toHaveBeenCalled()
  })

  it('throws a cancelled drag away', () => {
    const onEventDrop = vi.fn()
    const block = renderGrid(onEventDrop)
    act(() => {
      fireEvent.pointerDown(block, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
      fireEvent.pointerMove(block, { clientX: 100, clientY: 148, pointerId: 1 })
      fireEvent.pointerCancel(block, { pointerId: 1 })
      fireEvent.pointerUp(block, { clientX: 100, clientY: 148, pointerId: 1 })
    })
    expect(onEventDrop).not.toHaveBeenCalled()
  })
})

describe('events on more than one day', () => {
  afterEach(cleanup)
  Element.prototype.scrollTo ??= () => {}

  const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 14 + i))
  const titles: Record<string, string> = { late: 'Late shift', trip: 'Trip' }
  function renderWeek(occurrences: Occurrence[]) {
    render(
      <TimeGrid
        days={week}
        occurrences={occurrences}
        eventFor={(o) => ({ id: o.eventId, title: titles[o.eventId] }) as unknown as CalendarEvent}
        calendarColor={() => null}
        onSlotClick={() => {}}
        onEventClick={() => {}}
        onEventDrop={() => {}}
        canMove={() => true}
        today={dayKey(week[0]!)}
      />,
    )
  }

  it('splits a timed one past midnight into a block on each day, which stay put', () => {
    renderWeek([
      {
        eventId: 'late',
        recurrenceId: null,
        start: new Date(2026, 8, 15, 22),
        end: new Date(2026, 8, 16, 2),
        allDay: false,
      },
    ])
    const blocks = screen.getAllByRole('button', { name: /Late shift/ })
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.style.top).toBe(`${22 * 48}px`)
    expect(blocks[1]!.style.top).toBe('0px')
    expect(blocks[1]!.style.height).toBe(`${2 * 48}px`)
    for (const b of blocks) expect(b.className).not.toContain('cursor-grab')
  })

  it('draws a day or more as one bar across the all-day row', () => {
    renderWeek([
      {
        eventId: 'trip',
        recurrenceId: null,
        start: new Date(2026, 8, 12, 9),
        end: new Date(2026, 8, 16, 18),
        allDay: false,
      },
    ])
    const [bar, ...rest] = screen.getAllByRole('button', { name: /Trip/ })
    expect(rest).toHaveLength(0)
    expect(bar!.closest('[data-testid="all-day-row"]')).not.toBeNull()
    // It began before Monday, so it runs from the first column, square there.
    expect(bar!.style.gridColumn).toBe('1 / 4')
    expect(bar!.className).toContain('rounded-l-none')
  })
})
