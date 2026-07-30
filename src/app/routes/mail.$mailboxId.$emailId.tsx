import { createFileRoute } from '@tanstack/react-router'
import { ReadingPane } from '../../features/mail/ReadingPane'
import { useAccounts, useEmail } from '../../features/mail/hooks'
import { t } from '../../lib/i18n'

export const Route = createFileRoute('/mail/$mailboxId/$emailId')({
  component: EmailView,
})

function EmailView() {
  const { mailboxId, emailId } = Route.useParams()
  const accounts = useAccounts()
  const account = accounts?.[0]
  const email = useEmail(account?.id, emailId)

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
