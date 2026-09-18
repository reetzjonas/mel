import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect } from 'react'
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
import { Logo } from '../ui/Logo'
import { Tooltip } from '../ui/Tooltip'
import { signOut } from '../services/accounts'
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
          ? 'flex flex-col items-center gap-0.5 rounded-control px-3 py-1 text-[11px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink [&.active]:text-accent'
          : 'flex items-center gap-1.5 rounded-control px-3.5 py-1.5 text-[13px] font-medium text-ink-muted transition-[color,background-color] duration-150 hover:bg-surface-2 hover:text-ink [&.active]:bg-accent [&.active]:text-accent-ink [&.active]:shadow-raised'
      }
    >
      <Icon name={icon} size={stacked ? 18 : 15} />
      {label}
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

function SignOutButton({ accountId }: { accountId: string }) {
  const navigate = useNavigate()
  return (
    <Tooltip label={t('settings.signOut')}>
      <button
        type="button"
        aria-label={t('settings.signOut')}
        onClick={() => {
          if (!confirm(t('settings.signOut.confirm'))) return
          void signOut(accountId).then(() => navigate({ to: '/mail' }))
        }}
        className={secondaryIconButtonClass}
      >
        <Icon name="signOut" />
      </button>
    </Tooltip>
  )
}

export function AppShell() {
  const accounts = useAccounts()
  const account = accounts?.[0]
  const { compose } = useUi()
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
  useEffect(() => {
    if (accountId && !locked) startScheduler(accountId)
  }, [accountId, locked])

  if (lockedIds === undefined) return null
  if (lockedIds.length > 0) return <UnlockGate accountIds={lockedIds} />

  const apps = visibleApps(account)
  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="glass sticky top-0 z-30 hidden h-13 shrink-0 items-center gap-5 px-4 sm:flex">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-ink shadow-raised">
            <Logo size={21} />
          </span>
          mel
        </span>
        <nav className="flex gap-1">
          {apps.map((a) => (
            <AppSwitcherLink key={a.to} to={a.to} icon={a.icon} label={t(a.key)} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          {account && (
            <StorageWarning accountId={account.id} enabled={account.capabilities.quota} />
          )}
          <ThemeToggle />
          {account && <SignOutButton accountId={account.id} />}
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
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      {/* Mobile: bottom navigation as app switcher */}
      <nav className="glass flex shrink-0 justify-around py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] sm:hidden">
        {apps.map((a) => (
          <AppSwitcherLink key={a.to} to={a.to} icon={a.icon} label={t(a.key)} stacked />
        ))}
        {/* Bottom bar is touch-only, where a hover tooltip never appears.
            Same stacked shape as the app links, so Settings reads as one of
            the row rather than a differently-styled extra. */}
        <button
          type="button"
          aria-label={t('settings.title')}
          onClick={() => settings.open('general')}
          className={`flex flex-col items-center gap-0.5 rounded-control px-3 py-1 text-[11px] font-medium transition-colors duration-150 ${
            settings.tab ? 'text-accent' : 'text-ink-muted hover:text-ink'
          }`}
        >
          <Icon name="settings" size={18} />
          {t('settings.title')}
        </button>
      </nav>

      {/* Keyed on what is being written: opening a draft while a compose
          window stands open has to start a new editor, not hand the old one a
          different `init` it never reads again. */}
      {compose && account && (
        <Compose key={compose.draftId ?? 'new'} accountId={account.id} init={compose} />
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
