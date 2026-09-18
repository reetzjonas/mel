import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSelection, type SelectableRow } from './selection'

const rows: SelectableRow[] = [
  { key: 'a', ids: ['a'] },
  { key: 'b', ids: ['b'] },
  { key: 'c', ids: ['c'] },
  { key: 'd', ids: ['d'] },
  // A folded conversation row: one click carries more than one id.
  { key: 'thread', ids: ['t1', 't2'] },
]

describe('useSelection', () => {
  it('starts with nothing selected and selecting off', () => {
    const { result } = renderHook(() => useSelection(rows))
    expect(result.current.selected.size).toBe(0)
    expect(result.current.selecting).toBe(false)
  })

  it('ticks a row on a plain click, and off again on a second one', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('b', false))
    expect(result.current.isSelected('b')).toBe(true)

    act(() => result.current.toggle('b', false))
    expect(result.current.isSelected('b')).toBe(false)
  })

  it('ticks and unticks every id a multi-id row carries together', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('thread', false))
    expect(result.current.isSelected('t1')).toBe(true)
    expect(result.current.isSelected('t2')).toBe(true)

    act(() => result.current.toggle('thread', false))
    expect(result.current.isSelected('t1')).toBe(false)
    expect(result.current.isSelected('t2')).toBe(false)
  })

  it('a click on a partly-ticked multi-id row fills it in rather than clearing it', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.setSelected(['t1']))
    act(() => result.current.toggle('thread', false))

    expect(result.current.isSelected('t1')).toBe(true)
    expect(result.current.isSelected('t2')).toBe(true)
  })

  it('shift-click extends from the anchor and adds the whole run', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('a', false)) // sets the anchor
    act(() => result.current.toggle('c', true)) // range a..c

    expect(result.current.isSelected('a')).toBe(true)
    expect(result.current.isSelected('b')).toBe(true)
    expect(result.current.isSelected('c')).toBe(true)
    expect(result.current.isSelected('d')).toBe(false)
  })

  it('a range works backwards from a later anchor too', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('d', false))
    act(() => result.current.toggle('b', true))

    expect(result.current.isSelected('b')).toBe(true)
    expect(result.current.isSelected('c')).toBe(true)
    expect(result.current.isSelected('d')).toBe(true)
    expect(result.current.isSelected('a')).toBe(false)
  })

  it('a range only ever adds — it never unticks a row it sweeps past', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('b', false)) // ticked and now the anchor
    act(() => result.current.toggle('a', false)) // ticked on its own, anchor moves here
    act(() => result.current.toggle('d', true)) // range a..d must not drop b

    expect(result.current.isSelected('a')).toBe(true)
    expect(result.current.isSelected('b')).toBe(true)
    expect(result.current.isSelected('c')).toBe(true)
    expect(result.current.isSelected('d')).toBe(true)
  })

  it('shift-click with no anchor yet falls back to a plain toggle', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('b', true))

    expect(result.current.isSelected('b')).toBe(true)
    expect(result.current.selected.size).toBe(1)
  })

  it('a stale key that is no longer in the rows is a no-op', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('gone', false))
    expect(result.current.selected.size).toBe(0)

    act(() => result.current.toggle('a', false))
    act(() => result.current.toggle('gone', true))
    expect(result.current.selected.size).toBe(1)
    expect(result.current.isSelected('a')).toBe(true)
  })

  it('setSelected replaces the selection outright and moves the anchor to its last id', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('a', false))
    act(() => result.current.setSelected(['c', 'd']))

    expect(result.current.selected).toEqual(new Set(['c', 'd']))

    // The anchor moved to 'd' (setSelected's last id, which is also row
    // 'd''s key here): a shift-click on 'a' now ranges from 'd' back to
    // 'a' — covering 'b' and 'c' too — rather than from the 'a' ticked
    // before setSelected ran.
    act(() => result.current.toggle('a', true))
    expect(result.current.selected).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('setSelected with an empty list clears the anchor too', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.setSelected(['a', 'b']))
    act(() => result.current.setSelected([]))

    expect(result.current.selected.size).toBe(0)
  })

  it('clear empties the selection, turns selecting off and drops the anchor', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.toggle('a', false))
    act(() => result.current.setSelecting(true))
    act(() => result.current.clear())

    expect(result.current.selected.size).toBe(0)
    expect(result.current.selecting).toBe(false)

    // The anchor is gone, so a follow-up shift-click cannot extend a range
    // from where selection used to be.
    act(() => result.current.toggle('c', true))
    expect(result.current.selected).toEqual(new Set(['c']))
  })

  it('setSelecting pins the touch checkbox affordance on and off', () => {
    const { result } = renderHook(() => useSelection(rows))

    act(() => result.current.setSelecting(true))
    expect(result.current.selecting).toBe(true)

    act(() => result.current.setSelecting(false))
    expect(result.current.selecting).toBe(false)
  })
})
