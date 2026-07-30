import { Outlet, createFileRoute, useParams } from '@tanstack/react-router'
import { t } from '../../lib/i18n'
import { ThreadList } from '../../features/mail/ThreadList'
import { useAccounts, useMailboxEmails } from '../../features/mail/hooks'

export const Route = createFileRoute('/mail/$mailboxId')({
  component: MailboxView,
})

function MailboxView() {
  const { mailboxId } = Route.useParams()
  const params = useParams({ strict: false }) as { emailId?: string }
  const accounts = useAccounts()
  const account = accounts?.[0]
  const emails = useMailboxEmails(account?.id, mailboxId)

  const inDetail = Boolean(params.emailId)

  return (
    <div className="flex h-full">
      <section
        className={`h-full w-full min-w-0 border-r border-line lg:block lg:w-96 lg:shrink-0 ${inDetail ? 'hidden' : ''}`}
      >
        {emails === undefined ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-muted">
            {t('mail.syncing')}
          </div>
        ) : (
          <ThreadList emails={emails} mailboxId={mailboxId} selectedId={params.emailId} />
        )}
      </section>
      <div className={`h-full min-w-0 flex-1 lg:block ${inDetail ? '' : 'hidden'}`}>
        <Outlet />
      </div>
    </div>
  )
}
