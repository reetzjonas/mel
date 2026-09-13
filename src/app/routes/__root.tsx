import { createRootRoute } from '@tanstack/react-router'
import { AppShell } from '../AppShell'
import {
  isSettingsAnchor,
  isSettingsTab,
  type SettingsAnchor,
  type SettingsTab,
} from '../../features/settings/tabs'

export const Route = createRootRoute({
  // Settings open as a modal over whatever screen is showing, so the open tab
  // is a search param on every route rather than a route of its own.
  validateSearch: (s: Record<string, unknown>): { settings?: SettingsTab; at?: SettingsAnchor } => {
    if (!isSettingsTab(s.settings)) return {}
    // The anchor only means anything alongside a tab, so it is dropped with it
    // rather than lingering in the URL after the dialog closes.
    return isSettingsAnchor(s.at) ? { settings: s.settings, at: s.at } : { settings: s.settings }
  },
  component: AppShell,
})
