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
      eventsByDay={new Map([[dayKey(day), [occ]]])}
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
