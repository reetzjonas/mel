import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAppBadge, showAppBadge } from './appBadge'

function withBadging(impl: { set?: () => Promise<void>; clear?: () => Promise<void> } = {}) {
  const setAppBadge = vi.fn(impl.set ?? (() => Promise.resolve()))
  const clearBadge = vi.fn(impl.clear ?? (() => Promise.resolve()))
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearBadge })
  return { setAppBadge, clearBadge }
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'setAppBadge')
  Reflect.deleteProperty(navigator, 'clearAppBadge')
})

describe('the app icon badge', () => {
  it('carries the count when there is one', () => {
    const { setAppBadge } = withBadging()

    showAppBadge(3)

    expect(setAppBadge).toHaveBeenCalledWith(3)
  })

  it('is a bare flag when the count is unknown', () => {
    // What the service worker has on a push: mail changed, but the number is
    // whatever the last sync saw, which is not something to put on screen.
    const { setAppBadge } = withBadging()

    showAppBadge()

    expect(setAppBadge).toHaveBeenCalledWith(undefined)
  })

  it('does nothing at all where the browser has no badging', () => {
    // Firefox and iOS Safari. Reaching for the method would throw and take
    // down whatever called it — a sign-out, in one case.
    expect(() => {
      showAppBadge(1)
      clearAppBadge()
    }).not.toThrow()
  })

  it('swallows the rejection an uninstalled app gets', async () => {
    // Chrome resolves this only for an installed PWA and rejects in a tab.
    // An unhandled rejection in the console for a decoration is not a trade
    // worth making.
    withBadging({ set: () => Promise.reject(new Error('not installed')) })

    showAppBadge(2)
    await Promise.resolve()

    expect(true).toBe(true)
  })
})
