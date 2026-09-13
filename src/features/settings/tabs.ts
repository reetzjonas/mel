/*
 * Tab identifiers live apart from the dialog so the root route can validate
 * the `?settings=` search param without importing React components.
 */
export const settingsTabs = [
  'general',
  'appearance',
  'mail',
  'notifications',
  'security',
  'account',
] as const

export type SettingsTab = (typeof settingsTabs)[number]

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (settingsTabs as readonly string[]).includes(value)
}

/*
 * Sections a link may point at inside a tab, so opening settings from
 * somewhere else lands on the thing it was about rather than at the top of a
 * long tab. A closed list for the same reason the tabs are one: the root
 * route validates `?at=` without importing any component.
 */
export const settingsAnchors = ['sieve', 'capabilities'] as const

export type SettingsAnchor = (typeof settingsAnchors)[number]

export function isSettingsAnchor(value: unknown): value is SettingsAnchor {
  return typeof value === 'string' && (settingsAnchors as readonly string[]).includes(value)
}

/** The DOM id a section carries, and what the dialog scrolls to. */
export function anchorId(anchor: SettingsAnchor): string {
  return `settings-${anchor}`
}
