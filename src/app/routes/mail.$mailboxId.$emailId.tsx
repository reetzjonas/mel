import { useEffect, useRef } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ReadingPane } from '../../features/mail/ReadingPane'
import { useAccounts, useEmail } from '../../features/mail/hooks'
import type { EmailHeader } from '../../domain/email'
import { t } from '../../lib/i18n'

export const Route = createFileRoute('/mail/$mailboxId/$emailId')({
  component: EmailView,
})

function EmailView() {
  const { mailboxId, emailId } = Route.useParams()
  const accounts = useAccounts()
  const account = accounts?.[0]
  const email = useEmail(account?.id, emailId)
  useCloseWhenMovedAway(mailboxId, emailId, email)

  if (!account || email === undefined) return null
  if (email === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        {t('mail.notFound')}
      </div>
    )
  }
  return (
    <ReadingPane
      accountId={account.id}
      email={email}
      mailboxId={mailboxId}
      ownEmail={account.label}
    />
  )
}

/*
 * Closes the pane once the open message leaves the place it was opened from —
 * archived, deleted or moved by a quick action, a swipe, a drag onto a folder,
 * the selection toolbar or another device. The pane's own toolbar already goes
 * back to the list; every other path left the message standing there after it
 * had gone from the list beside it.
 *
 * Judged by a change rather than by where the message is: a search hit can be
 * opened from a folder it is not in, and a link to a message not synced yet
 * is not a message that went away. So the folders it was in when it first
 * showed up are the baseline — the listed folder if it was in it, otherwise all
 * of them — and the pane closes when it is in none of those any more, or gone.
 *
 * A draft that is gone is not closed on: saving a draft replaces it with a new
 * id, and the compose window moves the pane over to that one (`followDraft`).
 * Closing here first would race it. A draft moved to Trash still closes.
 */
function useCloseWhenMovedAway(
  mailboxId: string,
  emailId: string,
  email: EmailHeader | null | undefined,
) {
  const navigate = useNavigate()
  const baseline = useRef<{ emailId: string; mailboxIds: string[]; draft: boolean } | null>(null)

  useEffect(() => {
    if (baseline.current?.emailId !== emailId) baseline.current = null
    // The live query can still hold the previous message for a render after
    // the route moved on; that one is no baseline for this.
    if (email === undefined || (email && email.id !== emailId)) return
    const current = baseline.current
    if (!current) {
      if (email) {
        const held = Object.keys(email.mailboxIds)
        baseline.current = {
          emailId,
          mailboxIds: held.includes(mailboxId) ? [mailboxId] : held,
          draft: Boolean(email.keywords['$draft']),
        }
      }
      return
    }
    if (email) {
      if (current.mailboxIds.some((id) => email.mailboxIds[id])) return
    } else if (current.draft) return
    baseline.current = null
    void navigate({ to: '/mail/$mailboxId', params: { mailboxId }, search: (prev) => prev })
  }, [email, emailId, mailboxId, navigate])
}
