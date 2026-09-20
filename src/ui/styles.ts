/*
 * Shared class strings for the handful of controls that appear in nearly every
 * feature. Kept here so a restyle is one edit instead of a grep across forms.
 */

export const inputClass =
  'w-full rounded-control border border-line bg-canvas px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-2 focus:ring-accent/25'

export const primaryButtonClass =
  'min-h-11 rounded-control bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-raised transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 sm:min-h-0'

export const secondaryButtonClass =
  'min-h-11 rounded-control border border-line px-4 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink sm:min-h-0'

/**
 * A circular, icon-only accent button — the "new X" action (compose, new
 * contact, new note, ...). Three call sites hand-rolled this same string
 * before it lived here.
 */
export const primaryIconButtonClass =
  'min-h-11 min-w-11 rounded-control bg-accent p-2 text-accent-ink shadow-raised transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-95 sm:min-h-0 sm:min-w-0'

/**
 * A circular, icon-only neutral button — theme toggle, sign out, settings,
 * a calendar's prev/next. Quieter than `primaryIconButtonClass`, for a
 * control that isn't the primary action on its screen.
 */
export const secondaryIconButtonClass =
  'min-h-11 min-w-11 rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink sm:min-h-0 sm:min-w-0'

/** The wrapper around a row of mutually exclusive options (Calendar's Month/Week/Day). */
export const segmentedControlClass = 'flex items-center gap-0.5 rounded-control bg-surface-2 p-0.5'

/** One option inside `segmentedControlClass`; pass the active one on every render. */
export function segmentedOptionClass(active: boolean): string {
  return `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
    active ? 'bg-raised text-ink shadow-raised' : 'text-ink-muted hover:text-ink'
  }`
}

/** Modal/popover surface: floats above the app with a soft ring instead of a hard border. */
export const overlayPanelClass = 'rounded-panel bg-raised shadow-overlay ring-1 ring-line'

/** Full-screen scrim behind modals. */
export const scrimClass = 'fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]'

/** Shared mobile-sheet / desktop-dialog placement for finite modal panels. */
export const modalScrimClass =
  'fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6'

/** Shared surface for a bottom sheet on phones and a floating panel on wider screens. */
export const modalPanelClass =
  'animate-rise flex w-full flex-col overflow-hidden bg-raised sm:rounded-panel sm:shadow-overlay sm:ring-1 sm:ring-line'
