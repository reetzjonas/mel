import { createContext, useContext } from 'react'

/*
 * The context and its hook, apart from the provider that fills them.
 *
 * Not tidiness: a module that exports both a component and something else
 * cannot be hot-reloaded reliably, and the provider sits at the root of the
 * tree — losing Fast Refresh there means losing it for the whole app. See
 * docs/notes/fast-refresh.md.
 */

export type ThemePreference = 'light' | 'dark' | 'system'

export const STORAGE_KEY = 'mel:theme'

export interface ThemeContextValue {
  preference: ThemePreference
  setPreference: (pref: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  return ctx
}

/**
 * Fired after a remote value is written to `STORAGE_KEY` directly (bypassing
 * `setPreference`, which only exists inside a mounted `ThemeProvider`) — see
 * `services/settings.ts`. `ThemeProvider` listens for it, since its own
 * `preference` is a `useState`, not something outside code can reach.
 */
export const THEME_PREFERENCE_EVENT = 'mel:theme-preference'

/** Apply a value pulled from sync, without going through `setPreference`. */
export function applyThemePreferenceSilently(pref: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, pref)
  window.dispatchEvent(new Event(THEME_PREFERENCE_EVENT))
}
