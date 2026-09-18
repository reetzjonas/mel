import { useCallback, useSyncExternalStore } from 'react'

/**
 * How wide an adjustable panel is, and what may change that.
 *
 * Split out from the components because the interesting parts are decisions,
 * not markup: what a stored width means on a screen it does not fit, what a
 * key press should do, and what happens when localStorage refuses to answer.
 *
 * Per device, not per account. The reason to make a list wider is the screen
 * it is being read on, and that does not change when a different account is
 * opened on the same machine.
 *
 * One shared module rather than one per app (generalized from Mail's own
 * `'sidebar'`/`'list'` in #93 phase 3): every app names its own panel with a
 * plain string id (`'mail-sidebar'`, `'contacts-list'`, …) and supplies its
 * own limits at the call site — there is no central table of every panel
 * that exists, so a limits object lives as a module-level constant beside
 * whichever component uses it, not here.
 */

/** The custom property a panel takes its width from, at `lg` and above. */
export const PANEL_WIDTH_VAR = '--mel-panel-w'

export interface PanelLimits {
  min: number
  max: number
  /** What the panel is before it has ever been resized. */
  initial: number
}

/** What one arrow key moves, and what Shift makes of it. */
const STEP = 16
const FINE_STEP = 4

/** Every stored width lives under this prefix, so a reset can find them all
 *  without a central list of every panel id that exists. */
const PREFIX = 'mel:panel:'
const storageKey = (id: string) => `${PREFIX}${id}`

/**
 * A width this panel may actually have.
 *
 * `available` is the width of everything the panel shares its row with. A
 * stored width is only as good as the screen it was stored on: carry a laptop
 * away from a wide monitor and a 720px message list leaves nothing for the
 * message itself. So the panel may never take more than half of what is
 * there, however wide it was yesterday — and that ceiling wins over the
 * configured maximum, but never over the minimum, since a panel narrower than
 * its minimum is not usable at any screen size.
 */
export function clampWidth(limits: PanelLimits, width: number, available?: number): number {
  const { min, max, initial } = limits
  if (!Number.isFinite(width)) return initial
  const ceiling =
    available && Number.isFinite(available) && available > 0 ? Math.min(max, available / 2) : max
  return Math.round(Math.min(Math.max(width, min), Math.max(ceiling, min)))
}

/**
 * The width remembered for this device, or null if there is none to have.
 *
 * Anything unreadable answers null rather than throwing: localStorage is
 * absent in a private window in some browsers, and a layout that refuses to
 * render because a preference could not be read would be a poor trade.
 */
export function readStoredWidth(id: string, limits: PanelLimits): number | null {
  try {
    const raw = localStorage.getItem(storageKey(id))
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? clampWidth(limits, value) : null
  } catch {
    return null
  }
}

export function storeWidth(id: string, width: number): void {
  try {
    localStorage.setItem(storageKey(id), String(Math.round(width)))
  } catch {
    /* private window, or the quota is full — the width simply does not last */
  }
}

export function forgetWidth(id: string): void {
  try {
    localStorage.removeItem(storageKey(id))
  } catch {
    /* as above */
  }
}

/**
 * What a key press does to the width, or null for a key that is none of ours.
 *
 * The keyboard is not a fallback here but the only way to hit an exact width,
 * so Shift gives a finer step, and Home/End go straight to the extremes the
 * pointer would have to be dragged to.
 */
export function widthForKey(
  limits: PanelLimits,
  current: number,
  key: string,
  shiftKey = false,
  available?: number,
): number | null {
  const step = shiftKey ? FINE_STEP : STEP
  const { min, max } = limits
  switch (key) {
    case 'ArrowLeft':
      return clampWidth(limits, current - step, available)
    case 'ArrowRight':
      return clampWidth(limits, current + step, available)
    case 'Home':
      return min
    case 'End':
      return clampWidth(limits, max, available)
    default:
      return null
  }
}

/*
 * The live widths, as a store rather than per-component state.
 *
 * Settings can reset them, and the settings dialog opens *over* whichever app
 * is behind it rather than replacing it — so a panel already mounted has to
 * hear about the change. Component state would have needed a reload to take
 * effect, which is a heavy answer for a width.
 */
const widths = new Map<string, number>()
const listeners = new Set<() => void>()

function announce() {
  for (const fn of listeners) fn()
}

/** The width in force now, filled in from storage the first time it is asked. */
export function panelWidth(id: string, limits: PanelLimits): number {
  const known = widths.get(id)
  if (known !== undefined) return known
  const initial = readStoredWidth(id, limits) ?? limits.initial
  widths.set(id, initial)
  return initial
}

export function setPanelWidth(id: string, width: number): void {
  if (widths.get(id) === width) return
  widths.set(id, width)
  storeWidth(id, width)
  announce()
}

/**
 * Back to the width every panel shipped with, and stop remembering any of
 * them — every app's panel at once, since settings offers one button for
 * all of them rather than one per app.
 *
 * Forgetting is not the same as storing the default: "this device has no
 * opinion" must not become "this device wants exactly today's default", or a
 * later change to that default would silently not apply here.
 *
 * Scans localStorage for the shared prefix rather than iterating a list of
 * known panel ids, since there is no such list — a panel not currently
 * mounted (a different app than the one on screen right now) still has to be
 * reachable from here.
 */
export function resetPanelWidths(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key)
    }
  } catch {
    /* private window, or the quota is full */
  }
  widths.clear()
  announce()
}

/** Whether there is anything to reset, which is what the button hangs off. */
export function hasStoredWidths(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(PREFIX)) return true
    }
    return false
  } catch {
    return false
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/**
 * The remembered width of one panel, and the two ways it changes.
 *
 * `limits` should be a module-level constant at the call site, not an
 * object literal in the render — a fresh object every render would not
 * break anything (the snapshot it reads is still a plain number, so
 * `useSyncExternalStore` still bails out when nothing actually changed),
 * but there is no reason to reconstruct it either.
 */
export function usePanelWidth(id: string, limits: PanelLimits) {
  const read = useCallback(() => panelWidth(id, limits), [id, limits])
  const width = useSyncExternalStore(subscribe, read, read)

  const commit = useCallback((next: number) => setPanelWidth(id, next), [id])
  const reset = useCallback(() => resetPanelWidths(), [])

  return { width, commit, reset }
}
