import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { AddAccountForm } from '../../features/auth/AddAccountForm'
import { MailboxSidebar } from '../../features/mail/MailboxSidebar'
import { useAccounts, useMailboxes } from '../../features/mail/hooks'
import { useMailShortcuts } from '../../features/mail/shortcuts'
import { t } from '../../lib/i18n'
import { startScheduler } from '../../sync/scheduler'
import { Icon } from '../../ui/Icon'
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
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  useEffect(() => {
    if (account) startScheduler(account.id)
  }, [account?.id])

  // /mail without mailbox → jump to inbox once it is synced. The pathname
  // guard matters: mailboxes arrive asynchronously, and without it a click on
  // Calendar/Contacts during the first sync gets yanked back here the moment
  // the sync lands.
  useEffect(() => {
    if (params.mailboxId || !mailboxes?.length || pathname !== '/mail') return
    const inbox = mailboxes.find((m) => m.role === 'inbox') ?? mailboxes[0]!
    void navigate({ to: '/mail/$mailboxId', params: { mailboxId: inbox.id }, replace: true })
  }, [params.mailboxId, mailboxes, navigate, pathname])

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
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:px-3 sm:pb-3">
      {/* The sidebar rides directly on the canvas; only content panes float. */}
      <aside className={`w-full shrink-0 lg:block lg:w-56 ${inList ? 'hidden' : ''}`}>
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
          className="animate-rise fixed right-4 bottom-20 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-ink shadow-overlay transition-transform duration-150 active:scale-95 lg:hidden"
        >
          <Icon name="compose" size={22} />
        </button>
      )}

    </div>
  )
}
