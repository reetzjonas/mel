import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AddAccountForm } from '../../features/auth/AddAccountForm'
import { Compose } from '../../features/mail/Compose'
import { HelpOverlay } from '../../features/mail/HelpOverlay'
import { MailboxSidebar } from '../../features/mail/MailboxSidebar'
import { useAccounts, useMailboxes } from '../../features/mail/hooks'
import { useMailShortcuts } from '../../features/mail/shortcuts'
import { t } from '../../lib/i18n'
import { startScheduler } from '../../sync/scheduler'
import { Icon } from '../../ui/Icon'
import { Snackbar } from '../../ui/Snackbar'
import { useUi } from '../store'

export const Route = createFileRoute('/mail')({
  component: MailLayout,
})

function MailLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const mailboxes = useMailboxes(account?.id)
  const params = useParams({ strict: false }) as { mailboxId?: string; emailId?: string }
  const navigate = useNavigate()
  const { compose, openCompose } = useUi()

  useEffect(() => {
    if (account) startScheduler(account.id)
  }, [account?.id])

  // /mail without mailbox → jump to inbox once it is synced.
  useEffect(() => {
    if (params.mailboxId || !mailboxes?.length) return
    const inbox = mailboxes.find((m) => m.role === 'inbox') ?? mailboxes[0]!
    void navigate({ to: '/mail/$mailboxId', params: { mailboxId: inbox.id }, replace: true })
  }, [params.mailboxId, mailboxes, navigate])

  useMailShortcuts({
    accountId: account?.id,
    ownEmail: account?.label,
    mailboxId: params.mailboxId,
    emailId: params.emailId,
    mailboxes,
  })

  if (accounts === undefined) return null
  if (!account) {
    return <AddAccountForm onDone={() => void navigate({ to: '/mail' })} />
  }

  const inDetail = Boolean(params.emailId)
  const inList = Boolean(params.mailboxId)

  return (
    <div className="flex h-full">
      {/* Sidebar: always on desktop; on mobile only at /mail root */}
      <aside
        className={`w-full shrink-0 border-r border-line bg-surface lg:block lg:w-56 ${inList ? 'hidden' : ''}`}
      >
        <MailboxSidebar
          accountId={account.id}
          accountLabel={account.label}
          mailboxes={mailboxes ?? []}
        />
      </aside>
      <div className={`min-w-0 flex-1 lg:block ${inList ? '' : 'hidden'}`}>
        <Outlet />
      </div>

      {/* Mobile compose FAB */}
      {!inDetail && !compose && (
        <button
          type="button"
          aria-label={t('compose.new')}
          onClick={() => openCompose({})}
          className="fixed right-4 bottom-20 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-ink shadow-lg lg:hidden"
        >
          <Icon name="compose" size={22} />
        </button>
      )}

      {compose && <Compose accountId={account.id} init={compose} />}
      <HelpOverlay />
      <Snackbar />
    </div>
  )
}
