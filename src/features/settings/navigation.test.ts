import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { isSettingsTab, settingsTabs } from './tabs'

const navigate = vi.fn()
let search: Record<string, unknown> = {}
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}))

const { useSettingsRoute } = await import('./navigation')

/** What the navigate call would do to the current search params. */
function searchAfter(call: number) {
  const arg = navigate.mock.calls[call]![0] as {
    search: (prev: Record<string, unknown>) => Record<string, unknown>
    replace?: boolean
  }
  return { params: arg.search(search), replace: arg.replace ?? false }
}

describe('the settings dialog as a navigation', () => {
  beforeEach(() => {
    navigate.mockClear()
    search = {}
  })

  it('reads the open tab out of the URL, so a deep link lands on it', () => {
    search = { settings: 'security' }
    const { result } = renderHook(() => useSettingsRoute())
    expect(result.current.tab).toBe('security')
  })

  it('is closed when the URL says nothing about it', () => {
    const { result } = renderHook(() => useSettingsRoute())
    expect(result.current.tab).toBeUndefined()
  })

  it('pushes when opening, so Back is what closes it', () => {
    const { result } = renderHook(() => useSettingsRoute())
    result.current.open('mail')

    const { params, replace } = searchAfter(0)
    expect(params['settings']).toBe('mail')
    expect(replace).toBe(false)
  })

  it('replaces when switching tabs, so closing stays one press of Back', () => {
    // Pushing here would stack an entry per tab, and someone who looked
    // through four of them would have to press Back four times to leave.
    const { result } = renderHook(() => useSettingsRoute())
    result.current.select('account')

    const { params, replace } = searchAfter(0)
    expect(params['settings']).toBe('account')
    expect(replace).toBe(true)
  })

  it('closes by dropping the parameter, not by replacing the whole query', () => {
    // The rest of the query belongs to the screen behind the dialog — a
    // search term or a filter that closing must not throw away.
    search = { settings: 'general', q: 'rechnung', filter: 'unread' }
    const { result } = renderHook(() => useSettingsRoute())
    result.current.close()

    const { params } = searchAfter(0)
    expect(params['settings']).toBeUndefined()
    expect(params).toMatchObject({ q: 'rechnung', filter: 'unread' })
  })

  it('carries the surrounding query along when opening, too', () => {
    search = { q: 'rechnung' }
    const { result } = renderHook(() => useSettingsRoute())
    result.current.open('general')

    expect(searchAfter(0).params).toMatchObject({ q: 'rechnung', settings: 'general' })
  })
})

describe('isSettingsTab', () => {
  it('accepts every tab the dialog actually has', () => {
    for (const tab of settingsTabs) expect(isSettingsTab(tab)).toBe(true)
  })

  it('rejects anything else, so a hand-edited URL cannot open a tab that is not there', () => {
    expect(isSettingsTab('garbage')).toBe(false)
    expect(isSettingsTab('')).toBe(false)
    expect(isSettingsTab(undefined)).toBe(false)
    expect(isSettingsTab(null)).toBe(false)
    expect(isSettingsTab(1)).toBe(false)
    // Not a property lookup: inherited names must not pass for tabs.
    expect(isSettingsTab('toString')).toBe(false)
  })
})
