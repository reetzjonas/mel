/**
 * Whether the mail list groups messages into conversations.
 *
 * Stored per device (localStorage), like the theme and the calendar
 * visibility toggles — it is a view preference, not account state.
 */
const KEY = 'mel:conversations'

export function conversationView(): boolean {
  if (typeof localStorage === 'undefined') return true
  // Default on: the stored value is only ever written by the settings toggle,
  // so "nothing stored" means "never touched it", not "turned it off".
  return localStorage.getItem(KEY) !== 'off'
}

export function setConversationView(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off')
}
