/*
 * Opening settings is a navigation, not a piece of component state: the tab
 * rides in `?settings=` so a deep link lands on the right one and the back
 * button closes the dialog.
 */
import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { SettingsAnchor, SettingsTab } from './tabs'

export function useSettingsRoute() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { settings?: SettingsTab; at?: SettingsAnchor }

  /** `anchor` scrolls the dialog to one section instead of opening at the top. */
  const open = useCallback(
    (tab: SettingsTab, anchor?: SettingsAnchor) => {
      void navigate({ to: '.', search: (prev) => ({ ...prev, settings: tab, at: anchor }) })
    },
    [navigate],
  )

  // Switching tabs replaces rather than pushes, so that closing the dialog
  // stays a single press of Back however long someone browsed around in it.
  const select = useCallback(
    (tab: SettingsTab) => {
      // Switching tabs by hand drops any anchor: it described where the last
      // link wanted to land, not where this tab should open.
      void navigate({
        to: '.',
        search: (prev) => ({ ...prev, settings: tab, at: undefined }),
        replace: true,
      })
    },
    [navigate],
  )

  const close = useCallback(() => {
    void navigate({ to: '.', search: (prev) => ({ ...prev, settings: undefined, at: undefined }) })
  }, [navigate])

  return { tab: search.settings, anchor: search.at, open, select, close }
}
