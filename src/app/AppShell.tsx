import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { Compose } from '../features/mail/Compose'
import { HelpOverlay } from '../features/mail/HelpOverlay'
import { useAccounts } from '../features/mail/hooks'
import { t } from '../lib/i18n'
import { dekFor } from '../storage/crypto/keyring'
import { db } from '../storage/db'
import { Icon } from '../ui/Icon'
import { Logo } from '../ui/Logo'
import { Tooltip } from '../ui/Tooltip'
import { signOut } from '../services/accounts'
import { Snackbar } from '../ui/Snackbar'
import { useTheme } from './ThemeProvider'
import { UnlockGate } from './UnlockGate'
import { useUi } from './store'

const allApps = [
  { to: '/mail', key: 'app.mail', cap: 'mail' },
  { to: '/calendar', key: 'app.calendar', cap: 'calendars' },
  { to: '/contacts', key: 'app.contacts', cap: 'contacts' },
] as const

function AppSwitcherLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-ink-muted transition-[color,background-color] duration-150 hover:bg-surface-2 hover:text-ink [&.active]:bg-accent [&.active]:text-accent-ink [&.active]:shadow-raised"
    >
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
        className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
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
        className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
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
  const unlockVersion = useUi((s) => s.unlockVersion)
  const lockedIds = useLiveQuery(async () => {
    const rows = await db.accounts.toArray()
    return rows.filter((r) => r.encrypted && !dekFor(r.id)).map((r) => r.id)
  }, [unlockVersion])

  if (lockedIds === undefined) return null
  if (lockedIds.length > 0) return <UnlockGate accountIds={lockedIds} />

  // Capability-gated app switcher; before login only Mail is shown.
  const apps = allApps.filter((a) => a.cap === 'mail' || account?.capabilities[a.cap])
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
            <AppSwitcherLink key={a.to} to={a.to} label={t(a.key)} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          {account && <SignOutButton accountId={account.id} />}
          <Tooltip label={t('settings.title')}>
            <Link
              to="/settings"
              aria-label={t('settings.title')}
              className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink [&.active]:text-accent"
            >
              <Icon name="settings" />
            </Link>
          </Tooltip>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      {/* Mobile: bottom navigation as app switcher */}
      <nav className="glass flex shrink-0 justify-around py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] sm:hidden">
        {apps.map((a) => (
          <AppSwitcherLink key={a.to} to={a.to} label={t(a.key)} />
        ))}
        {/* Bottom bar is touch-only, where a hover tooltip never appears. */}
        <Link
          to="/settings"
          aria-label={t('settings.title')}
          className="rounded-full px-3.5 py-1 text-ink-muted [&.active]:bg-accent [&.active]:text-accent-ink"
        >
          <Icon name="settings" size={18} />
        </Link>
      </nav>

      {compose && account && <Compose accountId={account.id} init={compose} />}
      <HelpOverlay />
      <Snackbar />
    </div>
  )
}
