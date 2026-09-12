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
