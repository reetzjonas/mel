/*
 * Opening settings is a navigation, not a piece of component state: the tab
 * rides in `?settings=` so a deep link lands on the right one and the back
 * button closes the dialog.
 */
import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { SettingsTab } from './tabs'

export function useSettingsRoute() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { settings?: SettingsTab }

  const open = useCallback(
    (tab: SettingsTab) => {
      void navigate({ to: '.', search: (prev) => ({ ...prev, settings: tab }) })
    },
    [navigate],
  )

  // Switching tabs replaces rather than pushes, so that closing the dialog
  // stays a single press of Back however long someone browsed around in it.
  const select = useCallback(
    (tab: SettingsTab) => {
      void navigate({ to: '.', search: (prev) => ({ ...prev, settings: tab }), replace: true })
    },
    [navigate],
  )

  const close = useCallback(() => {
    void navigate({ to: '.', search: (prev) => ({ ...prev, settings: undefined }) })
  }, [navigate])

  return { tab: search.settings, open, select, close }
}
