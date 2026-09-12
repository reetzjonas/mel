import { useCallback, useSyncExternalStore } from 'react'

/**
 * How wide the two adjustable panels are, and what may change that.
 *
 * Split out from the components because the interesting parts are decisions,
 * not markup: what a stored width means on a screen it does not fit, what a
 * key press should do, and what happens when localStorage refuses to answer.
 *
 * Per device, not per account. The reason to make the folder list wider is
 * the screen it is being read on, and that does not change when a different
 * account is opened on the same machine.
 */

export type Panel = 'sidebar' | 'list'

/** The custom property the panels take their width from, at `lg` and above. */
export const PANEL_WIDTH_VAR = '--mel-panel-w'

export interface PanelLimits {
  min: number
  max: number
  /** What the panel was before it could be moved: w-56 and w-96. */
  initial: number
}

export const PANEL_LIMITS: Record<Panel, PanelLimits> = {
  sidebar: { min: 160, max: 420, initial: 224 },
  list: { min: 280, max: 720, initial: 384 },
}

/** What one arrow key moves, and what Shift makes of it. */
const STEP = 16
const FINE_STEP = 4

const keyFor = (panel: Panel) => `mel:panel:${panel}`

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
export function clampWidth(panel: Panel, width: number, available?: number): number {
  const { min, max } = PANEL_LIMITS[panel]
  if (!Number.isFinite(width)) return PANEL_LIMITS[panel].initial
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
export function readStoredWidth(panel: Panel): number | null {
  try {
    const raw = localStorage.getItem(keyFor(panel))
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? clampWidth(panel, value) : null
  } catch {
    return null
  }
}

export function storeWidth(panel: Panel, width: number): void {
  try {
    localStorage.setItem(keyFor(panel), String(Math.round(width)))
  } catch {
    /* private window, or the quota is full — the width simply does not last */
  }
}

export function forgetWidth(panel: Panel): void {
  try {
    localStorage.removeItem(keyFor(panel))
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
  panel: Panel,
  current: number,
  key: string,
  shiftKey = false,
  available?: number,
): number | null {
  const step = shiftKey ? FINE_STEP : STEP
  const { min, max } = PANEL_LIMITS[panel]
  switch (key) {
    case 'ArrowLeft':
      return clampWidth(panel, current - step, available)
    case 'ArrowRight':
      return clampWidth(panel, current + step, available)
    case 'Home':
      return min
    case 'End':
      return clampWidth(panel, max, available)
    default:
      return null
  }
}

/*
 * The live widths, as a store rather than per-component state.
 *
 * Settings can reset them, and the settings dialog opens *over* the mail
 * screen rather than replacing it — so the panels behind it are mounted and
 * have to hear about the change. Component state would have needed a reload
 * to take effect, which is a heavy answer for a width.
 */
const widths = new Map<Panel, number>()
const listeners = new Set<() => void>()

function announce() {
  for (const fn of listeners) fn()
}

/** The width in force now, filled in from storage the first time it is asked. */
export function panelWidth(panel: Panel): number {
  const known = widths.get(panel)
  if (known !== undefined) return known
  const initial = readStoredWidth(panel) ?? PANEL_LIMITS[panel].initial
  widths.set(panel, initial)
  return initial
}

export function setPanelWidth(panel: Panel, width: number): void {
  if (panelWidth(panel) === width) return
  widths.set(panel, width)
  storeWidth(panel, width)
  announce()
}

/**
 * Back to the widths the app shipped with, and stop remembering any.
 *
 * Forgetting is not the same as storing the default: "this device has no
 * opinion" must not become "this device wants exactly today's default", or a
 * later change to that default would silently not apply here.
 */
export function resetPanelWidths(): void {
  for (const panel of Object.keys(PANEL_LIMITS) as Panel[]) {
    forgetWidth(panel)
    // Dropped rather than set to the default: the next read derives it from
    // storage again, which is now empty, so there is one source of truth
    // instead of a cache that has to be kept in step with it.
    widths.delete(panel)
  }
  announce()
}

/** Whether there is anything to reset, which is what the button hangs off. */
export function hasStoredWidths(): boolean {
  return (Object.keys(PANEL_LIMITS) as Panel[]).some((p) => readStoredWidth(p) !== null)
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** The remembered width of one panel, and the two ways it changes. */
export function usePanelWidth(panel: Panel) {
  const read = useCallback(() => panelWidth(panel), [panel])
  const width = useSyncExternalStore(subscribe, read, read)

  const commit = useCallback((next: number) => setPanelWidth(panel, next), [panel])
  const reset = useCallback(() => resetPanelWidths(), [])

  return { width, commit, reset }
}
