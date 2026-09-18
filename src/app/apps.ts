import type { Account } from '../domain/account'
import type { MsgKey } from '../lib/i18n'
import type { IconName } from '../ui/Icon'

export interface AppTab {
  to: string
  key: MsgKey
  cap: 'mail' | 'calendars' | 'contacts' | 'files'
  icon: IconName
}

const ALL: AppTab[] = [
  { to: '/mail', key: 'app.mail', cap: 'mail', icon: 'mail' },
  { to: '/calendar', key: 'app.calendar', cap: 'calendars', icon: 'calendar' },
  { to: '/contacts', key: 'app.contacts', cap: 'contacts', icon: 'contact' },
  { to: '/files', key: 'app.files', cap: 'files', icon: 'folder' },
  // Notes are files, so the same capability answers for both — same icon
  // Notes' own empty state uses (EmptyState icon="draft" in notes.tsx).
  { to: '/notes', key: 'app.notes', cap: 'files', icon: 'draft' },
]

/**
 * The tabs this server has any use for.
 *
 * Before login there is no session to ask and Mail is where the login form
 * lives, so that one tab stands on its own until an account exists. After
 * that every tab answers to the capability behind it, Mail included — a
 * server offering only calendars has no mail view worth opening.
 */
export function visibleApps(account: Account | undefined): AppTab[] {
  return ALL.filter((a) => (account ? account.capabilities[a.cap] : a.cap === 'mail'))
}
