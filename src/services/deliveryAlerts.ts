import { hasFailure, type Submission } from '../domain/submission'
import { t } from '../lib/i18n'
import { useUi } from '../app/store'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'

/*
 * Saying that a sent message was refused, as soon as the sync learns of it
 * (issue #70) — rather than leaving it for whoever happens to open Sent.
 */

/** Recipients refused over these submissions, each once, in order. */
function refused(submissions: Submission[]): string[] {
  const out = new Set<string>()
  for (const s of submissions)
    if (hasFailure(s)) for (const r of s.recipients) if (r.delivered === 'no') out.add(r.email)
  return [...out]
}

export function deliveryAlertText(submissions: Submission[]): string {
  return t('mail.notDeliveredTo').replace('{recipients}', refused(submissions).join(', '))
}

/** Where the refused message opens: in Sent, where its band is. */
async function messageUrl(accountId: string, emailId: string): Promise<string> {
  const sent = await db.mailboxes.where({ accountId, role: 'sent' }).first()
  return sent ? `/mail/${sent.id}/${emailId}` : '/mail'
}

async function subjectOf(accountId: string, emailId: string): Promise<string | null> {
  const row = await db.emails.get([accountId, emailId])
  return row ? openEnvelope(row.payload).subject || null : null
}

/**
 * A system notification while the page is out of sight and may show one, the
 * snackbar while it is in front; nothing when neither would be seen — the
 * folder mark in the sidebar is still there when the page is next looked at.
 */
export async function showDeliveryAlert(
  accountId: string,
  submissions: Submission[],
  open: (url: string) => void,
): Promise<void> {
  const first = submissions[0]
  if (!first) return
  const text = deliveryAlertText(submissions)
  const url = await messageUrl(accountId, first.emailId)
  if (document.hidden) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const subject = await subjectOf(accountId, first.emailId)
    const options: NotificationOptions = {
      body: subject ? `“${subject}” · ${text}` : text,
      tag: `mel-undelivered-${first.id}`,
      icon: '/icon.svg',
      data: { url },
    }
    // Android Chrome refuses `new Notification`; only a registration may show one.
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) await registration.showNotification(t('mail.notDelivered'), options)
    else new Notification(t('mail.notDelivered'), options)
    return
  }
  useUi.getState().showSnackbar({
    message: text,
    actionLabel: t('mail.showMessage'),
    action: () => open(url),
  })
}

/** The refusal on this message has been looked at: Sent stops pointing at it. */
export async function markFailuresSeen(accountId: string, emailId: string): Promise<void> {
  await db.submissions
    .where({ accountId, emailId })
    .filter((row) => row.seen !== 1)
    .modify({ seen: 1 })
}
