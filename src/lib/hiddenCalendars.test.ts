import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyHiddenCalendarsSilently,
  hiddenCalendarsKey,
  readHiddenCalendars,
  useHiddenCalendars,
} from './hiddenCalendars'

const ACC = 'acc-hidden-cal'

beforeEach(() => {
  localStorage.clear()
})

describe('readHiddenCalendars', () => {
  it('answers empty for an account that has never toggled anything', () => {
    expect(readHiddenCalendars(ACC)).toEqual([])
  })

  it('survives a corrupted value rather than throwing', () => {
    localStorage.setItem(hiddenCalendarsKey(ACC), 'not json')
    expect(readHiddenCalendars(ACC)).toEqual([])
  })
})

describe('useHiddenCalendars', () => {
  it('toggles a calendar hidden and back, persisted per account', () => {
    const { result } = renderHook(() => useHiddenCalendars(ACC))
    expect(result.current.hidden.has('cal-1')).toBe(false)

    act(() => result.current.toggle('cal-1'))
    expect(result.current.hidden.has('cal-1')).toBe(true)
    expect(readHiddenCalendars(ACC)).toEqual(['cal-1'])

    act(() => result.current.toggle('cal-1'))
    expect(result.current.hidden.has('cal-1')).toBe(false)
    expect(readHiddenCalendars(ACC)).toEqual([])
  })

  it('reads freshly when the account switches, rather than keeping the last one’s value', () => {
    localStorage.setItem(hiddenCalendarsKey('other'), JSON.stringify(['cal-9']))
    const { result, rerender } = renderHook(({ id }) => useHiddenCalendars(id), {
      initialProps: { id: ACC as string | undefined },
    })
    expect(result.current.hidden.size).toBe(0)

    rerender({ id: 'other' })
    expect(result.current.hidden).toEqual(new Set(['cal-9']))
  })

  it('picks up a value applied from outside the hook — the point of the sync event', () => {
    const { result } = renderHook(() => useHiddenCalendars(ACC))
    expect(result.current.hidden.size).toBe(0)

    // Not through the hook's own `toggle` — this is what a remote sync uses
    // (services/settings.ts), and it has to reach an already-mounted view.
    act(() => applyHiddenCalendarsSilently(ACC, ['cal-5', 'cal-6']))

    expect(result.current.hidden).toEqual(new Set(['cal-5', 'cal-6']))
  })
})
