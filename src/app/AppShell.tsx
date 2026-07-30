import { Link, Outlet } from '@tanstack/react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { Compose } from '../features/mail/Compose'
import { HelpOverlay } from '../features/mail/HelpOverlay'
import { useAccounts } from '../features/mail/hooks'
import { t } from '../lib/i18n'
import { dekFor } from '../storage/crypto/keyring'
import { db } from '../storage/db'
import { Icon } from '../ui/Icon'
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
      className="rounded-full px-3.5 py-1 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink [&.active]:bg-accent [&.active]:text-accent-ink"
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
    <button
      type="button"
      onClick={() => setPreference(next)}
      title={`${t('theme.title')}: ${preference}`}
      className="rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      <Icon name={icon} />
    </button>
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
    <div className="flex h-full flex-col">
      <header className="hidden h-12 shrink-0 items-center gap-5 border-b border-line bg-surface px-4 sm:flex">
        <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-accent-ink">
            <Icon name="mail" size={14} />
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
          <Link
            to="/settings"
            title={t('settings.title')}
            className="rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-ink [&.active]:text-accent"
          >
            <Icon name="settings" />
          </Link>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
      {/* Mobile: bottom navigation as app switcher */}
      <nav className="flex shrink-0 justify-around border-t border-line bg-surface py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] sm:hidden">
        {apps.map((a) => (
          <AppSwitcherLink key={a.to} to={a.to} label={t(a.key)} />
        ))}
        <Link
          to="/settings"
          title={t('settings.title')}
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
