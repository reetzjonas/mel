import { Outlet, createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AddAccountForm } from '../../features/auth/AddAccountForm'
import { MailboxSidebar } from '../../features/mail/MailboxSidebar'
import { useAccounts, useMailboxes } from '../../features/mail/hooks'
import { syncAccount } from '../../sync/engine'

export const Route = createFileRoute('/mail')({
  component: MailLayout,
})

function MailLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const mailboxes = useMailboxes(account?.id)
  const params = useParams({ strict: false }) as { mailboxId?: string; emailId?: string }
  const navigate = useNavigate()

  // Refresh on window focus (proper push/scheduler comes in Phase 2).
  useEffect(() => {
    if (!account) return
    const onFocus = () => void syncAccount(account.id).catch(() => {})
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [account?.id])

  // /mail without mailbox → jump to inbox once it is synced.
  useEffect(() => {
    if (params.mailboxId || !mailboxes?.length) return
    const inbox = mailboxes.find((m) => m.role === 'inbox') ?? mailboxes[0]!
    void navigate({ to: '/mail/$mailboxId', params: { mailboxId: inbox.id }, replace: true })
  }, [params.mailboxId, mailboxes, navigate])

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
      {/* Mobile hint suppressed; detail styling handled in child routes */}
      {inDetail ? null : null}
    </div>
  )
}
