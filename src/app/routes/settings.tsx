import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTheme, type ThemePreference } from '../ThemeProvider'
import { useUi } from '../store'
import { useAccounts } from '../../features/mail/hooks'
import { t } from '../../lib/i18n'
import { removeAccount } from '../../services/accounts'
import {
  disableEncryption,
  enableEncryption,
  isAccountEncrypted,
  lock,
} from '../../services/encryption'
import { disableWebPush, enableWebPush, isSubscribed, webPushSupported } from '../../services/webPush'
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

function WebPushSetting({ accountId }: { accountId: string }) {
  const [state, setState] = useState<'loading' | 'unsupported' | 'off' | 'on' | 'busy'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      if (!(await webPushSupported(accountId))) return setState('unsupported')
      setState((await isSubscribed()) ? 'on' : 'off')
    })()
  }, [accountId])

  if (state === 'loading') return null
  if (state === 'unsupported')
    return <p className="text-sm text-ink-muted">{t('push.unsupported')}</p>

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">{state === 'on' ? t('push.enabled') : t('push.hint')}</p>
      <button
        type="button"
        disabled={state === 'busy'}
        className={
          state === 'on'
            ? 'rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2'
            : 'rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-50'
        }
        onClick={() => {
          const wasOn = state === 'on'
          setState('busy')
          setError(null)
          void (async () => {
            if (wasOn) {
              await disableWebPush(accountId)
              setState('off')
            } else {
              if (!(await requestNotificationPermission())) throw new Error(t('settings.notifications.denied'))
              await enableWebPush(accountId)
              setState('on')
            }
          })().catch((e) => {
            setError(e instanceof Error ? e.message : String(e))
            setState(wasOn ? 'on' : 'off')
          })
        }}
      >
        {state === 'busy' ? t('push.working') : state === 'on' ? t('push.disable') : t('push.enable')}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}

function EncryptionSetting({ accountId }: { accountId: string }) {
  const [enabled, setEnabled] = useState(() => isAccountEncrypted(accountId))
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bumpUnlock = useUi((s) => s.bumpUnlock)

  if (enabled) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">{t('crypto.enabled')}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2"
            onClick={() => {
              lock(accountId)
              bumpUnlock()
            }}
          >
            {t('crypto.lockNow')}
          </button>
          <button
            type="button"
            className="rounded-lg border border-danger px-3 py-2 text-sm text-danger hover:bg-danger/10"
            onClick={() => {
              const p = prompt(t('crypto.currentPassphrase'))
              if (!p) return
              setBusy(true)
              void disableEncryption(accountId, p)
                .then((ok) => {
                  if (ok) setEnabled(false)
                  else setError(t('crypto.wrongPassphrase'))
                })
                .finally(() => setBusy(false))
            }}
            disabled={busy}
          >
            {t('crypto.disable')}
          </button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    )
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        if (pass.length < 8 || pass !== confirm) {
          setError(pass !== confirm ? t('crypto.mismatch') : t('crypto.wrongPassphrase'))
          return
        }
        setBusy(true)
        void enableEncryption(accountId, pass)
          .then(() => setEnabled(true))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }}
    >
      <p className="text-sm text-ink-muted">{t('crypto.enableHint')}</p>
      <input
        className={input}
        type="password"
        placeholder={t('crypto.passphrase')}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        autoComplete="new-password"
      />
      <input
        className={input}
        type="password"
        placeholder={t('crypto.confirm')}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={busy || !pass}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
      >
        {busy ? t('crypto.working') : t('crypto.enable')}
      </button>
    </form>
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
          <Section title={t('push.section')}>
            <WebPushSetting accountId={account.id} />
          </Section>
        )}

        {account && (
          <Section title={t('crypto.section')}>
            <EncryptionSetting accountId={account.id} />
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
