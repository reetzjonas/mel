/*
 * The individual settings controls. Each one owns its own state and talks to
 * its service directly; the dialog only decides which tab a control sits on.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTheme, type ThemePreference } from '../../app/ThemeProvider'
import { useUi } from '../../app/store'
import { t } from '../../lib/i18n'
import { imagePolicy, setImagePolicy, type ImagePolicy } from '../../lib/imagePolicy'
import { resyncAccount, signOut } from '../../services/accounts'
import {
  disableEncryption,
  enableEncryption,
  isAccountEncrypted,
  lock,
} from '../../services/encryption'
import {
  disableWebPush,
  enableWebPush,
  isSubscribed,
  webPushSupported,
} from '../../services/webPush'
import { requestNotificationPermission } from '../../services/notifications'
import { hasStoredWidths, resetPanelWidths } from '../mail/panelWidths'
import { connectionFor } from '../../sync/connections'
import type { Account } from '../../domain/account'
import type { VacationSettings } from '../../providers/types'
import { Select } from '../../ui/Select'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-panel bg-surface p-5 shadow-panel">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export function LanguageSetting() {
  const stored = localStorage.getItem('mel:lang') ?? 'system'
  return (
    <Select
      className="sm:max-w-sm"
      aria-label={t('settings.language')}
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
    </Select>
  )
}

export function ThemeSetting() {
  const { preference, setPreference } = useTheme()
  return (
    <Select
      className="sm:max-w-sm"
      aria-label={t('settings.theme')}
      value={preference}
      onChange={(e) => setPreference(e.target.value as ThemePreference)}
    >
      <option value="system">{t('settings.theme.system')}</option>
      <option value="light">{t('settings.theme.light')}</option>
      <option value="dark">{t('settings.theme.dark')}</option>
    </Select>
  )
}

/**
 * Back to the widths the two draggable panels shipped with.
 *
 * Disabled while there is nothing stored, rather than doing nothing when
 * pressed: a handler that returns early belongs behind a visible `disabled`
 * (see docs/notes/e2e-stability.md — a dead button is dead for people and
 * tests alike).
 *
 * The panels are mounted behind this dialog, so the reset reaches them
 * directly; nothing here needs a reload.
 */
export function PanelWidthSetting() {
  const [stored, setStored] = useState(() => hasStoredWidths())
  const { showSnackbar } = useUi()
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={!stored}
        className={secondaryButtonClass}
        onClick={() => {
          resetPanelWidths()
          setStored(false)
          showSnackbar({ message: t('settings.layout.done') })
        }}
      >
        {t('settings.layout.reset')}
      </button>
      <p className="text-xs text-ink-subtle">{t('settings.layout.hint')}</p>
    </div>
  )
}

export function NotificationSetting() {
  const [status, setStatus] = useState(
    'Notification' in window ? Notification.permission : 'denied',
  )
  if (status === 'granted')
    return <p className="text-sm text-ink-muted">{t('settings.notifications.enabled')}</p>
  if (status === 'denied' && Notification.permission === 'denied')
    return <p className="text-sm text-ink-muted">{t('settings.notifications.denied')}</p>
  return (
    <button
      type="button"
      className={primaryButtonClass}
      onClick={() =>
        void requestNotificationPermission().then((ok) => setStatus(ok ? 'granted' : 'denied'))
      }
    >
      {t('settings.notifications.enable')}
    </button>
  )
}

export function VacationSetting({ accountId }: { accountId: string }) {
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
        className={inputClass}
        placeholder={t('settings.vacation.subject')}
        value={v.subject}
        onChange={(e) => setV({ ...v, subject: e.target.value })}
      />
      <textarea
        className={`${inputClass} min-h-24`}
        placeholder={t('settings.vacation.body')}
        value={v.text}
        onChange={(e) => setV({ ...v, text: e.target.value })}
      />
      <button
        type="button"
        className={primaryButtonClass}
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

export function WebPushSetting({ accountId }: { accountId: string }) {
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
      <p className="text-sm text-ink-muted">
        {state === 'on' ? t('push.enabled') : t('push.hint')}
      </p>
      <button
        type="button"
        disabled={state === 'busy'}
        className={state === 'on' ? secondaryButtonClass : primaryButtonClass}
        onClick={() => {
          const wasOn = state === 'on'
          setState('busy')
          setError(null)
          void (async () => {
            if (wasOn) {
              await disableWebPush(accountId)
              setState('off')
            } else {
              if (!(await requestNotificationPermission()))
                throw new Error(t('settings.notifications.denied'))
              await enableWebPush(accountId)
              setState('on')
            }
          })().catch((e) => {
            setError(e instanceof Error ? e.message : String(e))
            setState(wasOn ? 'on' : 'off')
          })
        }}
      >
        {state === 'busy'
          ? t('push.working')
          : state === 'on'
            ? t('push.disable')
            : t('push.enable')}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}

export function EncryptionSetting({ accountId }: { accountId: string }) {
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
            className={secondaryButtonClass}
            onClick={() => {
              lock(accountId)
              bumpUnlock()
            }}
          >
            {t('crypto.lockNow')}
          </button>
          <button
            type="button"
            className="rounded-control border border-danger px-3 py-2 text-sm text-danger transition-colors hover:bg-danger-wash"
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
        className={inputClass}
        type="password"
        placeholder={t('crypto.passphrase')}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        autoComplete="new-password"
      />
      <input
        className={inputClass}
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

export function ConversationSetting() {
  const { conversationView, setConversationView } = useUi()
  return (
    <div className="space-y-1">
      <Select
        className="sm:max-w-sm"
        aria-label={t('settings.conversations')}
        value={conversationView ? 'on' : 'off'}
        onChange={(e) => setConversationView(e.target.value === 'on')}
      >
        <option value="on">{t('settings.conversations.on')}</option>
        <option value="off">{t('settings.conversations.off')}</option>
      </Select>
      <p className="text-xs text-ink-subtle">{t('settings.conversations.hint')}</p>
    </div>
  )
}

export function ImageSetting() {
  const [policy, setPolicy] = useState<ImagePolicy>(() => imagePolicy())
  return (
    <div className="space-y-1">
      <Select
        className="sm:max-w-sm"
        aria-label={t('settings.images.ask')}
        value={policy}
        onChange={(e) => {
          const next = e.target.value as ImagePolicy
          setImagePolicy(next)
          setPolicy(next)
        }}
      >
        <option value="ask">{t('settings.images.ask')}</option>
        <option value="always">{t('settings.images.always')}</option>
      </Select>
      <p className="text-xs text-ink-subtle">{t('settings.images.hint')}</p>
    </div>
  )
}

export function ResyncSetting({ accountId }: { accountId: string }) {
  const [busy, setBusy] = useState(false)
  const { showSnackbar } = useUi()
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={busy}
        className={secondaryButtonClass}
        onClick={() => {
          setBusy(true)
          void resyncAccount(accountId)
            .then(() => showSnackbar({ message: t('settings.resync.done') }))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? t('settings.resync.running') : t('settings.resync')}
      </button>
      <p className="text-xs text-ink-subtle">{t('settings.resync.hint')}</p>
    </div>
  )
}

/**
 * Signing out closes the dialog by navigating away: the account it describes
 * stops existing, so leaving the panel standing would show empty tabs.
 */
export function AccountSetting({ account, onDone }: { account: Account; onDone: () => void }) {
  const navigate = useNavigate()
  return (
    <>
      <p className="text-sm text-ink-muted">{account.label}</p>
      <ResyncSetting accountId={account.id} />
      <button
        type="button"
        className="rounded-control border border-danger px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-wash"
        onClick={() => {
          void signOut(account.id).then(() => {
            onDone()
            void navigate({ to: '/mail' })
          })
        }}
      >
        {t('settings.signOut')}
      </button>
    </>
  )
}
