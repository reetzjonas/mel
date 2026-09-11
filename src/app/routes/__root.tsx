import { createRootRoute } from '@tanstack/react-router'
import { AppShell } from '../AppShell'
import { isSettingsTab, type SettingsTab } from '../../features/settings/tabs'

export const Route = createRootRoute({
  // Settings open as a modal over whatever screen is showing, so the open tab
  // is a search param on every route rather than a route of its own.
  validateSearch: (s: Record<string, unknown>): { settings?: SettingsTab } =>
    isSettingsTab(s.settings) ? { settings: s.settings } : {},
  component: AppShell,
})
