import { t } from '../lib/i18n'
import { inboxUnreadSince } from '../sync/scheduler'

const LAST_KEY = (accountId: string) => `mel:notified:${accountId}`

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  const result = await Notification.requestPermission()
  return result === 'granted'
}

/**
 * Tier-1 notifications: after each sync, notify about inbox mail newer than
 * the last check. (Tier 2, Web Push while the app is closed, comes in Phase 6.)
 */
export async function notifyNewMail(accountId: string): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const last = Number(localStorage.getItem(LAST_KEY(accountId)) ?? Date.now())
  localStorage.setItem(LAST_KEY(accountId), String(Date.now()))

  const fresh = await inboxUnreadSince(accountId, last + 1)
  for (const mail of fresh.slice(0, 5)) {
    const sender = mail.from[0]?.name || mail.from[0]?.email || t('mail.unknownSender')
    const n = new Notification(sender, {
      body: mail.subject || t('mail.noSubject'),
      tag: `mel-${accountId}-${mail.id}`,
      icon: '/icon.svg',
    })
    n.onclick = () => {
      window.focus()
      const inbox = Object.keys(mail.mailboxIds)[0]
      location.href = `/mail/${inbox}/${mail.id}`
    }
  }
}
