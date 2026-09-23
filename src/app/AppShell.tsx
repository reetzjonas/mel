import { Link, Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { Compose } from '../features/mail/Compose'
import { HelpOverlay } from '../features/mail/HelpOverlay'
import { useAppBadge } from '../features/mail/appBadge'
import { useAccounts } from '../features/mail/hooks'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { StorageWarning } from '../features/settings/StorageQuota'
import { useSettingsRoute } from '../features/settings/navigation'
import { t } from '../lib/i18n'
import { dekFor } from '../storage/crypto/keyring'
import { db } from '../storage/db'
import { Icon, type IconName } from '../ui/Icon'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Logo } from '../ui/Logo'
import { Tooltip } from '../ui/Tooltip'
import { signOut } from '../services/accounts'
import { startEventReminders } from '../services/eventReminders'
import { narrowPushSubscription } from '../services/webPush'
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
  const account = accounts?.[0]
  const { compose, closeCompose } = useUi()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const settings = useSettingsRoute()
  useAppBadge(account?.id)
  const unlockVersion = useUi((s) => s.unlockVersion)
  const lockedIds = useLiveQuery(async () => {
    const rows = await db.accounts.toArray()
    return rows.filter((r) => r.encrypted && !dekFor(r.id)).map((r) => r.id)
  }, [unlockVersion])

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
   * Depends on the id rather than the account object, so switching accounts
   * restarts it but a changed label or capability list does not.
   */
  const accountId = account?.id
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
    if (accountId && !locked) startScheduler(accountId)
  }, [accountId, locked])

  // Reads decrypted events, so like the scheduler it waits for the unlock, and
  // unlike it stops when the account or the lock changes: it holds no connection.
  useEffect(() => {
    if (!accountId || locked) return
    return startEventReminders(accountId)
  }, [accountId, locked])

  // A push subscription from before it named its types still wakes this
  // device for every change on any other one (see `PUSH_TYPES`).
  useEffect(() => {
    if (accountId && !locked) void narrowPushSubscription(accountId).catch(() => {})
  }, [accountId, locked])

  if (lockedIds === undefined) return null
  if (lockedIds.length > 0) return <UnlockGate accountIds={lockedIds} />

  const apps = visibleApps(account)
  const activeApp = apps.find((app) => pathname === app.to || pathname.startsWith(`${app.to}/`))
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
          title={t('settings.signOut')}
          message={t('settings.signOut.confirm')}
          cancelLabel={t('folder.cancel')}
          confirmLabel={t('settings.signOut')}
          onClose={() => setConfirmingSignOut(false)}
          onConfirm={() => {
            setConfirmingSignOut(false)
            void signOut(account.id).then(() => navigate({ to: '/mail' }))
          }}
        />
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
