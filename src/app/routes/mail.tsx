import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { AddAccountForm } from '../../features/auth/AddAccountForm'
import { MailboxDrawer } from '../../features/mail/MailboxDrawer'
import { MailboxSidebar } from '../../features/mail/MailboxSidebar'
import { useAccounts, useMailboxes } from '../../features/mail/hooks'
import { useMailShortcuts } from '../../features/mail/shortcuts'
import { CapabilityNotice } from '../../features/settings/ServerCapabilities'
import { t } from '../../lib/i18n'
import { PANEL_WIDTH_VAR, usePanelWidth, type PanelLimits } from '../../lib/panelWidths'
import { MobileFab } from '../../ui/MobileFab'
import { ResizeHandle } from '../../ui/ResizeHandle'
import { useUi } from '../store'

const SIDEBAR_LIMITS: PanelLimits = { min: 160, max: 420, initial: 224 }

export const Route = createFileRoute('/mail')({
  component: MailLayout,
})

function MailLayout() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const accountId = account?.id
  const mailboxes = useMailboxes(accountId)
  const params = useParams({ strict: false }) as { mailboxId?: string; emailId?: string }
  const navigate = useNavigate()
  const router = useRouter()
  const { compose, openCompose, setFolderDrawerOpen } = useUi()
  const canSend = account?.capabilities.submission ?? false
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const sidebar = usePanelWidth('mail-sidebar', SIDEBAR_LIMITS)
  const sidebarRef = useRef<HTMLElement | null>(null)

  /*
   * /mail without mailbox → jump to inbox once it is synced.
   *
   * The guard matters: mailboxes arrive asynchronously, and without it a click
   * on Calendar/Contacts during the first sync gets yanked back here the
   * moment the sync lands.
   *
   * It reads the router's *live* location rather than `pathname`, which is
   * this render's snapshot of it. The mailboxes arriving and the navigation
   * leaving are two separate updates, and nothing orders them: a render
   * carrying the new mailboxes can commit while still closing over the old
   * pathname, and then this fires right after the user has left. `pathname`
   * stays in the deps so a plain arrival back on /mail still re-runs it.
   */
  useEffect(() => {
    if (params.mailboxId || !mailboxes?.length) return
    if (router.latestLocation.pathname !== '/mail') return
    const inbox = mailboxes.find((m) => m.role === 'inbox') ?? mailboxes[0]!
    // Carries the search along: a deep link like /settings redirects through
    // /mail, and dropping the params here would close the settings dialog
    // again the moment the inbox arrives.
    void navigate({
      to: '/mail/$mailboxId',
      params: { mailboxId: inbox.id },
      search: (prev) => prev,
      replace: true,
    })
  }, [params.mailboxId, mailboxes, navigate, pathname, router])

  // Leaving mail altogether closes the drawer: it is bound to this layout, and
  // coming back from Calendar to a drawer left standing open is a surprise.
  useEffect(() => () => setFolderDrawerOpen(false), [setFolderDrawerOpen])

  useMailShortcuts({
    accountId,
    ownEmail: account?.label,
    mailboxId: params.mailboxId,
    emailId: params.emailId,
    mailboxes,
    canSend,
  })

  if (accounts === undefined) return null
  if (!account) {
    return <AddAccountForm onDone={() => void navigate({ to: '/mail' })} />
  }
  // Reached by URL even with the tab gone from the switcher, and by everyone
  // whose bookmark predates the server losing the capability.
  if (!account.capabilities.mail) return <CapabilityNotice reason="caps.unsupported.mail" />

  const inDetail = Boolean(params.emailId)
  const inList = Boolean(params.mailboxId)

  return (
    <div className="flex h-full gap-0 bg-canvas sm:gap-3 sm:p-3">
      {/* The sidebar rides directly on the canvas; only content panes float. */}
      <aside
        ref={sidebarRef}
        // The width only applies from lg up, where both panes are on screen at
        // once. Narrower than that the panels take turns and w-full wins, so
        // the phone layout is untouched by whatever was dragged on a desktop.
        style={{ [PANEL_WIDTH_VAR]: `${sidebar.width}px` } as React.CSSProperties}
        className={`w-full shrink-0 lg:block lg:w-[var(--mel-panel-w)] ${inList ? 'hidden' : ''}`}
      >
        <MailboxSidebar account={account} mailboxes={mailboxes ?? []} />
      </aside>
      <ResizeHandle
        limits={SIDEBAR_LIMITS}
        label={t('mail.resizeSidebar')}
        width={sidebar.width}
        targetRef={sidebarRef}
        onCommit={sidebar.commit}
        onReset={sidebar.reset}
      />
      <div className={`min-w-0 flex-1 lg:block ${inList ? '' : 'hidden'}`}>
        <Outlet />
      </div>
      <MailboxDrawer account={account} mailboxes={mailboxes ?? []} />

      {/* Mobile compose FAB */}
      {canSend && !inDetail && !compose && (
        <MobileFab
          icon="compose"
          label={t('compose.new')}
          onClick={() => openCompose({})}
          until="lg"
        />
      )}
    </div>
  )
}
