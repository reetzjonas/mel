import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTheme, type ThemePreference } from '../ThemeProvider'
import { useAccounts } from '../../features/mail/hooks'
import { t } from '../../lib/i18n'
import { removeAccount } from '../../services/accounts'
import { requestNotificationPermission } from '../../services/notifications'
import { connectionFor } from '../../sync/connections'
import { stopScheduler } from '../../sync/scheduler'
import type { VacationSettings } from '../../providers/types'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

const input =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function LanguageSetting() {
  const stored = localStorage.getItem('mel:lang') ?? 'system'
  return (
    <select
      className={input}
      defaultValue={stored}
      onChange={(e) => {
        if (e.target.value === 'system') localStorage.removeItem('mel:lang')
        else localStorage.setItem('mel:lang', e.target.value)
        location.reload()
      }}
    >
      <option value="system">{t('settings.language.system')}</option>
      <option value="en">English</option>
      <option value="de">Deutsch</option>
    </select>
  )
}

function NotificationSetting() {
  const [status, setStatus] = useState(
    'Notification' in window ? Notification.permission : 'denied',
  )
  if (status === 'granted') return <p className="text-sm text-ink-muted">{t('settings.notifications.enabled')}</p>
  if (status === 'denied' && Notification.permission === 'denied')
    return <p className="text-sm text-ink-muted">{t('settings.notifications.denied')}</p>
  return (
    <button
      type="button"
      className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink"
      onClick={() =>
        void requestNotificationPermission().then((ok) => setStatus(ok ? 'granted' : 'denied'))
      }
    >
      {t('settings.notifications.enable')}
    </button>
  )
}

function VacationSetting({ accountId }: { accountId: string }) {
  const [v, setV] = useState<VacationSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void connectionFor(accountId).then((c) => c.mail?.getVacation().then(setV))
  }, [accountId])

  if (!v) return <p className="text-sm text-ink-muted">{t('mail.loading')}</p>
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.target.checked })}
        />
        {t('settings.vacation.enabled')}
      </label>
      <input
        className={input}
        placeholder={t('settings.vacation.subject')}
        value={v.subject}
        onChange={(e) => setV({ ...v, subject: e.target.value })}
      />
      <textarea
        className={`${input} min-h-24`}
        placeholder={t('settings.vacation.body')}
        value={v.text}
        onChange={(e) => setV({ ...v, text: e.target.value })}
      />
      <button
        type="button"
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink"
        onClick={() =>
          void connectionFor(accountId).then((c) =>
            c.mail?.setVacation(v).then(() => {
              setSaved(true)
              setTimeout(() => setSaved(false), 2000)
            }),
          )
        }
      >
        {saved ? t('settings.vacation.saved') : t('settings.vacation.save')}
      </button>
    </div>
  )
}

function SettingsPage() {
  const { preference, setPreference } = useTheme()
  const accounts = useAccounts()
  const account = accounts?.[0]
  const navigate = useNavigate()

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-lg space-y-4 p-4 sm:py-8">
        <h1 className="text-lg font-semibold">{t('settings.title')}</h1>

        <Section title={t('settings.language')}>
          <LanguageSetting />
        </Section>

        <Section title={t('settings.theme')}>
          <select
            className={input}
            value={preference}
            onChange={(e) => setPreference(e.target.value as ThemePreference)}
          >
            <option value="system">{t('settings.theme.system')}</option>
            <option value="light">{t('settings.theme.light')}</option>
            <option value="dark">{t('settings.theme.dark')}</option>
          </select>
        </Section>

        <Section title={t('settings.notifications')}>
          <NotificationSetting />
        </Section>

        {account?.capabilities.vacation && (
          <Section title={t('settings.vacation')}>
            <VacationSetting accountId={account.id} />
          </Section>
        )}

        {account && (
          <Section title={t('settings.account')}>
            <p className="text-sm text-ink-muted">{account.label}</p>
            <button
              type="button"
              className="rounded-lg border border-danger px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
              onClick={() => {
                stopScheduler(account.id)
                void removeAccount(account.id).then(() => navigate({ to: '/mail' }))
              }}
            >
              {t('settings.account.remove')}
            </button>
          </Section>
        )}
      </div>
    </div>
  )
}
