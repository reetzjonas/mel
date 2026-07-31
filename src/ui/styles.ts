/*
 * Shared class strings for the handful of controls that appear in nearly every
 * feature. Kept here so a restyle is one edit instead of a grep across forms.
 */

export const inputClass =
  'w-full rounded-control border border-line bg-canvas px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-2 focus:ring-accent/25'

export const primaryButtonClass =
  'rounded-control bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-raised transition-[background-color,transform] duration-150 hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100'

export const secondaryButtonClass =
  'rounded-control border border-line px-4 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink'

/** Modal/popover surface: floats above the app with a soft ring instead of a hard border. */
export const overlayPanelClass = 'rounded-panel bg-raised shadow-overlay ring-1 ring-line'

/** Full-screen scrim behind modals. */
export const scrimClass = 'fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]'
