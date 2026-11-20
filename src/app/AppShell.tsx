import { setActiveAccount, useActiveAccount } from '../lib/activeAccount'
import { Link, Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { AddAccountForm } from '../features/auth/AddAccountForm'
import { ReauthPrompt } from '../features/auth/ReauthPrompt'
import { Compose } from '../features/mail/Compose'
import { HelpOverlay } from '../features/mail/HelpOverlay'
import { useAppBadge } from '../features/mail/appBadge'
import { useAccounts, useSessions } from '../features/mail/hooks'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { StorageWarning } from '../features/settings/StorageQuota'
import { useSettingsRoute } from '../features/settings/navigation'
import { t } from '../lib/i18n'
import { lockedSessionIds } from '../services/encryption'
import { migrateLegacySessions } from '../storage/sessions'
import { Icon, type IconName } from '../ui/Icon'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Logo } from '../ui/Logo'
import { OverflowMenu } from '../ui/OverflowMenu'
import { Tooltip } from '../ui/Tooltip'
import { signOut, upgradeToTokens } from '../services/accounts'
import { showDeliveryAlert } from '../services/deliveryAlerts'
import { startEventReminders } from '../services/eventReminders'
import { refreshPushSubscription } from '../services/webPush'
import { onNewDeliveryFailures } from '../sync/deliveryEvents'
import { startScheduler } from '../sync/scheduler'
import { Snackbar } from '../ui/Snackbar'
import { secondaryIconButtonClass } from '../ui/styles'
import { visibleApps } from './apps'
import { useTheme } from './theme'
import { UnlockGate } from './UnlockGate'
import { useUi } from './store'

function AppSwitcherLink({
  to,
  icon,
  label,
  stacked = false,
}: {
  to: string
  icon: IconName
  label: string
  /** The mobile bottom bar: icon above a small label, the usual tab-bar
   *  shape — five icon+label pairs side by side would crowd a phone width
   *  the way the desktop header never has to worry about. */
  stacked?: boolean
}) {
  return (
    <Link
      to={to}
      className={
        stacked
          ? 'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-control px-1 py-1.5 text-[11px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink [&.active]:text-accent'
          : 'flex items-center gap-1.5 rounded-control px-3.5 py-1.5 text-[13px] font-medium text-ink-muted transition-[color,background-color] duration-150 hover:bg-surface-2 hover:text-ink [&.active]:bg-accent [&.active]:text-accent-ink [&.active]:shadow-raised'
      }
    >
      <Icon name={icon} size={stacked ? 18 : 15} />
      <span className={stacked ? 'max-w-full truncate' : undefined}>{label}</span>
    </Link>
  )
}

function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  const next = preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark'
  const icon = preference === 'dark' ? 'moon' : preference === 'light' ? 'sun' : 'monitor'
  return (
    <Tooltip label={`${t('theme.title')}: ${preference}`}>
      <button
        type="button"
        onClick={() => setPreference(next)}
        aria-label={`${t('theme.title')}: ${preference}`}
        className={secondaryIconButtonClass}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  )
}

function SignOutButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label={t('settings.signOut')}>
      <button
        type="button"
        aria-label={t('settings.signOut')}
        onClick={onClick}
        className={secondaryIconButtonClass}
      >
        <Icon name="signOut" />
      </button>
    </Tooltip>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const router = useRouter()
  const accounts = useAccounts()
  const account = useActiveAccount(accounts)
  const sessions = useSessions()
  const session = sessions?.find((s) => s.id === account?.sessionId)
  const { compose, closeCompose } = useUi()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [addingAccount, setAddingAccount] = useState(false)
  const settings = useSettingsRoute()
  useAppBadge(account?.id)
  const unlockVersion = useUi((s) => s.unlockVersion)
  const lockedIds = useLiveQuery(() => lockedSessionIds(), [unlockVersion])

  /*
   * Live updates belong to the app, not to the mail screen.
   *
   * This used to start in the /mail route, so opening mel on a bookmark to
   * /calendar or /contacts — or reloading while standing there — left the
   * device with no sync at all: no polling, no SSE, nothing until someone
   * happened to visit Mail. It hid behind `/` redirecting to /mail, which is
   * how almost everyone arrives.
   *
   * Not while an account is still locked: a sync would write rows the crypto
   * middleware has no key to seal, and every one of those writes throws.
   * Every account, not just the one on screen: switching to another shows
   * mail that is already there, and its reminders and delivery alerts come
   * in all along. Keyed on the ids rather than the account objects, so a
   * changed label or capability list restarts nothing.
   */
  const accountIdList = (accounts ?? []).map((a) => a.id).join(' ')
  // One account of each session, for what is the session's: its token, its push.
  const sessionLeads = [
    ...new Map((accounts ?? []).map((a) => [a.sessionId, a.id] as const)).entries(),
  ]
    .map(([sessionId, accountId]) => `${sessionId}=${accountId}`)
    .join(' ')
  const locked = Boolean(lockedIds?.length)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const composeHistoryEntry = useRef(false)
  // Where the composer's entry was pushed, and where the route stood last while
  // it was open. They differ once a draft save has re-pointed the reading pane
  // at the message's new id (`followDraft`).
  const composeBaseHref = useRef('')
  const composeHref = useRef('')
  // From the history's own notifications rather than the rendered route, and
  // pushes and replaces only: by the time Back's popstate reaches the listener
  // below, the router has already re-rendered onto the entry beneath.
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        if (composeHistoryEntry.current && (action.type === 'PUSH' || action.type === 'REPLACE'))
          composeHref.current = location.href
      }),
    [router],
  )

  // A modal compose window is one navigation level above whatever is behind
  // it. Giving it a same-URL history entry makes browser Back dismiss the
  // modal before the underlying app can move to its previous route.
  useEffect(() => {
    if (!compose || composeHistoryEntry.current) return
    composeHistoryEntry.current = true
    composeBaseHref.current = composeHref.current = router.history.location.href
    router.history.push(router.history.location.href, { melCompose: true })
  }, [compose, router])

  useEffect(() => {
    const onPopState = () => {
      if (!composeHistoryEntry.current || !useUi.getState().compose) return
      composeHistoryEntry.current = false
      closeCompose()
      /*
       * Saving a draft replaces the message under a new id and `followDraft`
       * re-points the route at it — but only the composer's own entry, the one
       * just popped. The entry beneath still names the destroyed message, so
       * landing on it shows "Message not found" over a list that has the draft.
       * Carry the route the composer ended on down onto that entry.
       */
      const ended = composeHref.current
      if (ended !== composeBaseHref.current) {
        // After the router has handled this same event and settled on the
        // entry beneath.
        setTimeout(() => router.history.replace(ended), 0)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [closeCompose, router])

  const dismissCompose = () => {
    if (composeHistoryEntry.current) router.history.back()
    else closeCompose()
  }
  useEffect(() => {
    if (locked) return
    for (const id of accountIdList.split(' ').filter(Boolean)) startScheduler(id)
  }, [accountIdList, locked])

  // Reads decrypted events, so like the scheduler it waits for the unlock, and
  // unlike it stops when the accounts or the lock change: it holds no connection.
  useEffect(() => {
    if (locked) return
    const stops = accountIdList.split(' ').filter(Boolean).map(startEventReminders)
    return () => stops.forEach((stop) => stop())
  }, [accountIdList, locked])

  // A stored password becomes a refresh token where the server has learnt the
  // token login since the account was added (issue #97). Unlocked only: the
  // password is sealed behind the passphrase until then. A push subscription
  // expires unless it is renewed (a week on Stalwart), and one from before it
  // named its types wakes this device for every change.
  useEffect(() => {
    if (locked) return
    void migrateLegacySessions().catch(() => {})
    for (const lead of sessionLeads.split(' ').filter(Boolean)) {
      const [sessionId, accountId] = lead.split('=') as [string, string]
      void upgradeToTokens(sessionId).catch(() => {})
      void refreshPushSubscription(accountId).catch(() => {})
    }
  }, [sessionLeads, locked])

  // A sent message refused by a recipient's server says so where it will be
  // seen, not only in Sent (issue #70) — from whichever account sent it.
  useEffect(() => {
    if (locked) return
    return onNewDeliveryFailures((id, submissions) => {
      void showDeliveryAlert(id, submissions, (url) => {
        setActiveAccount(id)
        void navigate({ to: url })
      }).catch(() => {})
    })
  }, [locked, navigate])

  if (lockedIds === undefined) return null
  if (lockedIds.length > 0) return <UnlockGate sessionIds={lockedIds} />

  const apps = visibleApps(account)
  const activeApp = apps.find((app) => pathname === app.to || pathname.startsWith(`${app.to}/`))

  /*
   * The account menu: every account, the one on screen ticked, and another to
   * add. Switching lands on the same app's start, since a folder, message or
   * contact open now belongs to the account being left.
   */
  const accountMenu = account && accounts && (
    <OverflowMenu
      label={t('account.menu')}
      text={account.label}
      actions={[
        ...accounts.map((a) => ({
          label: a.label,
          pressed: a.id === account.id,
          onSelect: () => {
            if (a.id === account.id) return
            setActiveAccount(a.id)
            void navigate({ to: activeApp?.to ?? '/mail' })
          },
        })),
        { label: t('login.title'), icon: 'plus' as const, onSelect: () => setAddingAccount(true) },
      ]}
    />
  )
  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="glass sticky top-0 z-30 hidden h-13 shrink-0 items-center gap-5 px-4 sm:flex">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-ink shadow-raised">
            <Logo size={21} />
          </span>
          mel
        </span>
        <nav aria-label={t('app.navigation')} className="flex gap-1">
          {apps.map((a) => (
            <AppSwitcherLink key={a.to} to={a.to} icon={a.icon} label={t(a.key)} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          {account && (
            <StorageWarning accountId={account.id} enabled={account.capabilities.quota} />
          )}
          {accountMenu}
          <ThemeToggle />
          {account && <SignOutButton onClick={() => setConfirmingSignOut(true)} />}
          <Tooltip label={t('settings.title')}>
            <button
              type="button"
              aria-label={t('settings.title')}
              onClick={() => settings.open('general')}
              className={`${secondaryIconButtonClass} ${settings.tab ? '!text-accent' : ''}`}
            >
              <Icon name="settings" />
            </button>
          </Tooltip>
        </div>
      </header>
      <header className="glass z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 sm:hidden">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink shadow-raised">
          <Logo size={18} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {activeApp ? t(activeApp.key) : 'mel'}
        </span>
        {account && <StorageWarning accountId={account.id} enabled={account.capabilities.quota} />}
        {accountMenu}
        <button
          type="button"
          aria-label={t('settings.title')}
          onClick={() => settings.open('general')}
          className={`${secondaryIconButtonClass} ${settings.tab ? '!text-accent' : ''}`}
        >
          <Icon name="settings" />
        </button>
      </header>
      {account && confirmingSignOut && (
        <ConfirmDialog
          title={`${t('settings.signOut')}: ${session?.label ?? account.label}`}
          message={
            (accounts ?? []).filter((a) => a.sessionId === account.sessionId).length > 1
              ? `${t('settings.signOut.confirm')} ${t('settings.signOut.allAccounts')}`
              : t('settings.signOut.confirm')
          }
          cancelLabel={t('folder.cancel')}
          confirmLabel={t('settings.signOut')}
          onClose={() => setConfirmingSignOut(false)}
          onConfirm={() => {
            setConfirmingSignOut(false)
            void signOut(account.id).then(() => navigate({ to: '/mail' }))
          }}
        />
      )}
      {/* One per login: its accounts share the credentials, and so the refusal. */}
      {[...new Map((accounts ?? []).map((a) => [a.sessionId, a] as const)).values()].map((a) => (
        <ReauthPrompt
          key={a.sessionId}
          accountId={a.id}
          label={sessions?.find((s) => s.id === a.sessionId)?.label ?? a.label}
          named={(sessions?.length ?? 0) > 1}
        />
      ))}
      {addingAccount && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-canvas">
          <AddAccountForm
            onCancel={() => setAddingAccount(false)}
            onDone={(id) => {
              setAddingAccount(false)
              setActiveAccount(id)
              void navigate({ to: '/mail' })
            }}
          />
        </div>
      )}
      <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden">
        <Outlet />
      </main>
      {/* Mobile: bottom navigation as app switcher */}
      <nav
        aria-label={t('app.navigation')}
        className="glass flex shrink-0 justify-around py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] sm:hidden"
      >
        {apps.map((a) => (
          <AppSwitcherLink key={a.to} to={a.to} icon={a.icon} label={t(a.key)} stacked />
        ))}
      </nav>

      {/* Keyed on what is being written: opening a draft while a compose
          window stands open has to start a new editor, not hand the old one a
          different `init` it never reads again. */}
      {compose && account && (
        <Compose
          key={compose.draftId ?? 'new'}
          accountId={account.id}
          init={compose}
          onClose={dismissCompose}
        />
      )}
      {settings.tab && (
        <SettingsDialog
          tab={settings.tab}
          anchor={settings.anchor}
          onTab={settings.select}
          onClose={settings.close}
        />
      )}
      <HelpOverlay />
      <Snackbar />
    </div>
  )
}
