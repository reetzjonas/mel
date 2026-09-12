import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_LIMITS,
  clampWidth,
  forgetWidth,
  readStoredWidth,
  storeWidth,
  hasStoredWidths,
  resetPanelWidths,
  usePanelWidth,
  widthForKey,
} from './panelWidths'

beforeEach(() => {
  localStorage.clear()
  // The widths are a module-level store now; without this the first test to
  // read one would decide what every later test sees.
  resetPanelWidths()
})
afterEach(() => vi.unstubAllGlobals())

describe('a width a panel may actually have', () => {
  it('holds each panel inside its own limits', () => {
    expect(clampWidth('sidebar', 10)).toBe(PANEL_LIMITS.sidebar.min)
    expect(clampWidth('sidebar', 9999)).toBe(PANEL_LIMITS.sidebar.max)
    expect(clampWidth('list', 10)).toBe(PANEL_LIMITS.list.min)
    expect(clampWidth('list', 9999)).toBe(PANEL_LIMITS.list.max)
  })

  it('never lets a panel take more than half the room it shares', () => {
    /*
     * A stored width is only as good as the screen it was stored on. Carry a
     * laptop away from a wide monitor and a 720px message list leaves nothing
     * for the message — the pane it was widened to read.
     */
    expect(clampWidth('list', 720, 1000)).toBe(500)
    expect(clampWidth('sidebar', 420, 600)).toBe(300)
  })

  it('keeps the minimum even on a screen too narrow for it', () => {
    // Half of a small viewport can be less than the panel needs to be usable
    // at all; a 40px folder list is not a smaller folder list, it is none.
    expect(clampWidth('sidebar', 300, 200)).toBe(PANEL_LIMITS.sidebar.min)
  })

  it('ignores an available width that says nothing', () => {
    // Before the first layout pass the container measures 0, and a panel
    // clamped to half of nothing would collapse on every reload.
    for (const nonsense of [0, -100, Number.NaN, undefined]) {
      expect(clampWidth('list', 500, nonsense), String(nonsense)).toBe(500)
    }
  })

  it('falls back to the original width rather than passing nonsense on', () => {
    expect(clampWidth('list', Number.NaN)).toBe(PANEL_LIMITS.list.initial)
  })

  it('answers whole pixels', () => {
    // Half a pixel of panel is a blurred border, and it would be written back
    // to localStorage to be re-read for ever.
    expect(clampWidth('list', 384.6)).toBe(385)
  })
})

describe('what this device remembers', () => {
  it('gives back what was stored, clamped to what is allowed now', () => {
    // The limits may have changed since; a stored width is a preference, not
    // a licence to escape them.
    storeWidth('list', 9999)
    expect(readStoredWidth('list')).toBe(PANEL_LIMITS.list.max)
  })

  it('is null when nothing was ever stored, so the caller can use its default', () => {
    expect(readStoredWidth('sidebar')).toBeNull()
  })

  it('keeps the two panels apart', () => {
    storeWidth('sidebar', 300)
    expect(readStoredWidth('list')).toBeNull()
    expect(readStoredWidth('sidebar')).toBe(300)
  })

  it('forgets on request, which is what a reset is', () => {
    storeWidth('list', 500)
    forgetWidth('list')
    expect(readStoredWidth('list')).toBeNull()
  })

  it('treats an unreadable store as no preference rather than an error', () => {
    /*
     * Safari in a private window throws on access rather than answering
     * empty. A layout that refuses to render because a preference could not
     * be read would be a poor trade.
     */
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })

    expect(readStoredWidth('list')).toBeNull()
    expect(() => storeWidth('list', 400)).not.toThrow()
    expect(() => forgetWidth('list')).not.toThrow()
  })

  it('ignores a value that is not a number', () => {
    // Hand-edited, or written by an older version that stored something else.
    localStorage.setItem('mel:panel:list', 'wide please')
    expect(readStoredWidth('list')).toBeNull()
  })
})

describe('resizing from the keyboard', () => {
  it('moves in both directions, and further without Shift than with it', () => {
    // The keyboard is not a fallback here: it is the only way to reach an
    // exact width, so it needs a coarse step and a fine one.
    const coarse = widthForKey('list', 400, 'ArrowRight')!
    const fine = widthForKey('list', 400, 'ArrowRight', true)!

    expect(coarse).toBeGreaterThan(fine)
    expect(fine).toBeGreaterThan(400)
    expect(widthForKey('list', 400, 'ArrowLeft')).toBeLessThan(400)
  })

  it('stops at the limits instead of walking past them', () => {
    expect(widthForKey('sidebar', PANEL_LIMITS.sidebar.min, 'ArrowLeft')).toBe(
      PANEL_LIMITS.sidebar.min,
    )
    expect(widthForKey('sidebar', PANEL_LIMITS.sidebar.max, 'ArrowRight')).toBe(
      PANEL_LIMITS.sidebar.max,
    )
  })

  it('goes straight to either end on Home and End', () => {
    // Dragging from 700px back to the narrowest is a long way with an arrow
    // key, and the extremes are exactly where someone undoing a mistake wants
    // to land.
    expect(widthForKey('list', 700, 'Home')).toBe(PANEL_LIMITS.list.min)
    expect(widthForKey('list', 300, 'End')).toBe(PANEL_LIMITS.list.max)
  })

  it('respects the room available, the same as dragging does', () => {
    expect(widthForKey('list', 480, 'End', false, 1000)).toBe(500)
    expect(widthForKey('list', 496, 'ArrowRight', false, 1000)).toBe(500)
  })

  it('leaves every other key alone', () => {
    // The handle sits in the tab order; a null is what lets Tab, Enter and
    // everything else behave normally.
    for (const key of ['Tab', 'Enter', ' ', 'a', 'ArrowUp', 'Escape']) {
      expect(widthForKey('list', 400, key), key).toBeNull()
    }
  })
})

describe('the width a panel starts the session with', () => {
  it('picks up where this device left off', () => {
    storeWidth('list', 500)

    const { result } = renderHook(() => usePanelWidth('list'))

    expect(result.current.width).toBe(500)
  })

  it('uses the width it shipped with when nothing was stored', () => {
    const { result } = renderHook(() => usePanelWidth('sidebar'))
    expect(result.current.width).toBe(PANEL_LIMITS.sidebar.initial)
  })

  it('writes a committed width straight through, so a reload finds it', () => {
    // Committing without storing would make every resize last exactly as long
    // as the tab does.
    const { result } = renderHook(() => usePanelWidth('list'))

    act(() => result.current.commit(460))

    expect(result.current.width).toBe(460)
    expect(readStoredWidth('list')).toBe(460)
  })

  it('resets both panels at once, since settings offers one button for the pair', () => {
    /*
     * Two separate widths, one control. Resetting only the panel whose hook
     * happened to be mounted would leave the other wide with nothing in the
     * settings screen admitting it.
     */
    storeWidth('sidebar', 300)
    storeWidth('list', 600)

    resetPanelWidths()

    expect(readStoredWidth('sidebar')).toBeNull()
    expect(readStoredWidth('list')).toBeNull()
  })

  it('reaches a panel that is already on screen', () => {
    // The settings dialog opens over the mail screen rather than replacing it,
    // so the panels behind it are mounted and have to hear about the reset —
    // component state would have needed a reload to take effect.
    const { result } = renderHook(() => usePanelWidth('list'))
    act(() => result.current.commit(520))
    expect(result.current.width).toBe(520)

    act(() => resetPanelWidths())

    expect(result.current.width).toBe(PANEL_LIMITS.list.initial)
  })

  it('knows whether there is anything to reset, which is what disables the button', () => {
    // A button that does nothing when pressed is worse than one that is
    // visibly unavailable.
    expect(hasStoredWidths()).toBe(false)

    storeWidth('list', 500)
    expect(hasStoredWidths()).toBe(true)

    resetPanelWidths()
    expect(hasStoredWidths()).toBe(false)
  })

  it('forgets the preference on reset rather than storing the default', () => {
    /*
     * Two different states: "this device has no opinion" and "this device
     * wants exactly the default". Storing the default on reset would make a
     * later change to that default silently not apply here.
     */
    const { result } = renderHook(() => usePanelWidth('list'))
    act(() => result.current.commit(520))

    act(() => result.current.reset())

    expect(result.current.width).toBe(PANEL_LIMITS.list.initial)
    expect(readStoredWidth('list')).toBeNull()
  })
})
