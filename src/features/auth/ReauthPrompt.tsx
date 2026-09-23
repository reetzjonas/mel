import { useRef, useState, useSyncExternalStore } from 'react'
import { t } from '../../lib/i18n'
import { TotpRequired } from '../../providers/jmap/client/auth'
import { reauthenticate } from '../../services/accounts'
import { getSyncStatus, subscribeSyncStatus } from '../../sync/scheduler'
import { DialogHeader } from '../../ui/DialogHeader'
import { Icon } from '../../ui/Icon'
import { inputClass, modalPanelClass, primaryButtonClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'

/*
 * The way back in once the server stops taking the stored credentials: a
 * refresh token that expired or was revoked, or a password changed elsewhere.
 * A band under the header rather than a dialog that opens by itself — the mail
 * already on the device stays readable, and a modal springing up over it would
 * be the louder of the two. Nothing local is touched either way.
 */
export function ReauthPrompt({ accountId, label }: { accountId: string; label: string }) {
  const status = useSyncExternalStore(
    subscribeSyncStatus,
    () => getSyncStatus(accountId),
    () => getSyncStatus(accountId),
  )
  const [open, setOpen] = useState(false)
  if (status.error?.kind !== 'auth') return null
  return (
    <>
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-danger-wash px-4 py-2 text-sm text-danger"
      >
        <Icon name="offline" size={15} className="shrink-0" />
        <span className="min-w-0 flex-[1_1_12rem]">{t('auth.expired')}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-semibold hover:underline"
        >
          {t('reauth.action')}
        </button>
      </div>
      {open && <ReauthDialog accountId={accountId} label={label} onClose={() => setOpen(false)} />}
    </>
  )
}

function ReauthDialog({
  accountId,
  label,
  onClose,
}: {
  accountId: string
  label: string
  onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, initialFocus: passwordRef, onClose })
  const [secret, setSecret] = useState('')
  const [totp, setTotp] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await reauthenticate(accountId, secret, needsTotp ? totp.trim() : undefined)
      onClose()
    } catch (err) {
      if (err instanceof TotpRequired) setNeedsTotp(true)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('reauth.title')}
        className={`${modalPanelClass} max-w-sm max-sm:rounded-t-panel`}
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 32}px` } : undefined}
      >
        <DialogHeader
          title={t('reauth.title')}
          closeLabel={t('folder.cancel')}
          closeRef={close}
          onClose={onClose}
        />
        <form onSubmit={(e) => void submit(e)} className="space-y-4 overflow-y-auto p-5">
          <p className="text-sm text-ink-muted">{t('reauth.hint')}</p>
          {/* For the password manager: which login this password belongs to. */}
          <input type="email" value={label} autoComplete="username" readOnly hidden />
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-ink-muted">
              {t('login.password')} · {label}
            </span>
            <input
              ref={passwordRef}
              className={inputClass}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {needsTotp && <TotpField value={totp} onChange={setTotp} />}
          {error && (
            <p className="rounded-control bg-danger-wash px-3 py-2 text-sm text-danger">{error}</p>
          )}
          <button type="submit" disabled={busy} className={`w-full ${primaryButtonClass}`}>
            {busy ? t('login.connecting') : t('reauth.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}

/** The one-time code field, shared by the login and the re-sign-in. */
export function TotpField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-ink-muted">{t('login.totp')}</span>
      <input
        className={`${inputClass} tracking-widest`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        // Takes focus when it appears: the code is the one thing left to type.
        autoFocus
        required
      />
      <span className="block text-xs text-ink-subtle">{t('login.totpHint')}</span>
    </label>
  )
}
