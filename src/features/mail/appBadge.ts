import { useEffect } from 'react'
import { clearAppBadge, showAppBadge } from '../../lib/appBadge'
import { useMailboxes } from './hooks'

/**
 * Keeps the app icon's badge on the unread inbox count.
 *
 * The inbox alone, not every folder: the badge answers "is anything waiting
 * for me", and one filed-away folder somebody keeps unread on purpose would
 * light it permanently, which teaches people to ignore it.
 */
export function useAppBadge(accountId: string | undefined): void {
  const mailboxes = useMailboxes(accountId)
  const unread = mailboxes?.find((m) => m.role === 'inbox')?.unreadEmails

  useEffect(() => {
    if (unread === undefined) return
    if (unread > 0) showAppBadge(unread)
    else clearAppBadge()
  }, [unread])
}
