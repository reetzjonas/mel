import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { applyThemeTuning, useThemeTuning } from './themeTuning'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'mel:theme'

interface ThemeContextValue {
  preference: ThemePreference
  setPreference: (pref: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? 'system',
  )

  const { tuning } = useThemeTuning()

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, preference)
    /*
     * The tuning is re-derived here rather than once at startup, and it has to
     * be: light and dark share their hues but not their lightness, so the
     * overrides are built from whichever palette is in force. Re-applying
     * after the attribute changes is what keeps the two in step.
     */
    const apply = () => {
      document.documentElement.dataset.theme = resolve(preference)
      applyThemeTuning(document.documentElement, tuning)
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [preference, tuning])

  return <ThemeContext value={{ preference, setPreference }}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  return ctx
}
