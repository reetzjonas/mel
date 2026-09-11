/*
 * Tab identifiers live apart from the dialog so the root route can validate
 * the `?settings=` search param without importing React components.
 */
export const settingsTabs = ['general', 'mail', 'notifications', 'security', 'account'] as const

export type SettingsTab = (typeof settingsTabs)[number]

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (settingsTabs as readonly string[]).includes(value)
}
