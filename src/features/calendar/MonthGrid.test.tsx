import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { CalendarEvent, Occurrence } from '../../domain/calendar'
import { MonthGrid } from './MonthGrid'

afterEach(cleanup)

/** Six weeks from Monday 31 August 2026. */
const days = Array.from({ length: 42 }, (_, i) => new Date(2026, 7, 31 + i))
const occ = (eventId: string, start: Date, end: Date, allDay = false): Occurrence => ({
  eventId,
  recurrenceId: null,
  start,
  end,
  allDay,
})

function renderMonth(occurrences: Occurrence[], onMoveDays = vi.fn()) {
  render(
    <MonthGrid
      days={days}
      month={8}
      occurrences={occurrences}
      eventFor={(o) => ({ id: o.eventId, title: o.eventId }) as unknown as CalendarEvent}
      eventColor={() => null}
      canMove={() => true}
      today="2026-09-01"
      onDayClick={() => {}}
      onEventClick={() => {}}
      onMoveDays={onMoveDays}
    />,
  )
  return onMoveDays
}

describe('the month grid', () => {
  it('draws an event on several days as a bar in each week it is in', () => {
    // Thursday 10 to Tuesday 15 September: four days in one week, two in the next.
    renderMonth([occ('Holiday', new Date(2026, 8, 10), new Date(2026, 8, 16), true)])
    const bars = screen.getAllByRole('button', { name: 'Holiday' })
    expect(bars.map((b) => b.style.gridColumn)).toEqual(['4 / 8', '1 / 3'])
    expect(bars[0]!.className).toContain('rounded-r-none')
    expect(bars[1]!.className).toContain('rounded-l-none')
  })

  it('lists a one-day event under the bars on its day, with its time', () => {
    renderMonth([
      occ('Holiday', new Date(2026, 8, 10), new Date(2026, 8, 12), true),
      occ('Dentist', new Date(2026, 8, 10, 9, 30), new Date(2026, 8, 10, 10)),
    ])
    const chip = screen.getByRole('button', { name: /Dentist/ })
    expect(chip.style.gridRow).toBe('3')
    expect(chip.textContent).toMatch(/9:30|09:30/)
  })

  it('counts what does not fit', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      occ(`e${i}`, new Date(2026, 8, 10, 8 + i), new Date(2026, 8, 10, 9 + i)),
    )
    renderMonth(many)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByText('+2')).toBeTruthy()
  })

  it('moves a bar by the days it is dragged, from the day it was picked up on', () => {
    const onMoveDays = renderMonth([occ('Trip', new Date(2026, 8, 8), new Date(2026, 8, 11), true)])
    const bar = screen.getByRole('button', { name: 'Trip' })
    const row = bar.parentElement!
    // A week row 700px wide: 100px a day, Monday first.
    row.getBoundingClientRect = () => ({ left: 0, width: 700, top: 0, height: 100 }) as DOMRect
    const dataTransfer = {
      setData: () => {},
      types: ['application/x-mel-event'],
      dropEffect: '',
      effectAllowed: '',
    }
    // jsdom's drag events carry no coordinates of their own.
    const at = (make: typeof createEvent.dragStart, el: Element, clientX: number) => {
      const ev = make(el, { dataTransfer })
      Object.defineProperty(ev, 'clientX', { value: clientX })
      fireEvent(el, ev)
    }
    act(() => {
      at(createEvent.dragStart, bar, 250) // picked up on Wednesday
      at(createEvent.dragOver, row, 550)
      at(createEvent.drop, row, 550) // let go on Saturday
    })
    expect(onMoveDays).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'Trip' }), 3)
  })
})
