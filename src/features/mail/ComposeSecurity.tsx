import { useEffect, useState, useSyncExternalStore } from 'react'
import { t, tf } from '../../lib/i18n'
import type { EmailAddress } from '../../domain/email'
import { keysVersion, onKeysChanged, unlockedKeys, unlockOwnKeys } from '../../services/pgpKeys'
import type { SecureOptions } from '../../services/pgpWrite'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

/**
 * The recipients an encrypted message could not reach, looked up as the
 * fields change — so "cannot encrypt to Carol" is said while typing, not
 * discovered at Send.
 */
function useMissingKeys(accountId: string, encrypt: boolean, recipients: EmailAddress[]): string[] {
  const key = recipients.map((r) => r.email.toLowerCase()).join(',')
  const [result, setResult] = useState<{ key: string; missing: string[] } | null>(null)
  useEffect(() => {
    if (!encrypt || !key) return
    let alive = true
    const timer = setTimeout(() => {
      void import('../../services/pgpWrite')
        .then(({ recipientsWithoutKey }) => recipientsWithoutKey(accountId, key.split(',')))
        .then((missing) => alive && setResult({ key, missing }))
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [accountId, encrypt, key])
  return encrypt && result?.key === key ? result.missing : []
}

function Toggle({
  icon,
  label,
  pressed,
  onToggle,
}: {
  icon: IconName
  label: string
  pressed: boolean
  onToggle: () => void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onToggle}
        className={`flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-control p-2 text-xs transition-colors sm:min-h-0 sm:min-w-0 ${
          pressed
            ? 'bg-accent-wash text-accent'
            : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <Icon name={icon} size={16} />
        <span className="hidden font-medium sm:inline">{label}</span>
      </button>
    </Tooltip>
  )
}

/** The two switches, for the composer's footer. */
export function SecurityToggles({
  value,
  onChange,
}: {
  value: SecureOptions
  onChange: (next: SecureOptions) => void
}) {
  return (
    <>
      <Toggle
        icon="lock"
        label={t('compose.encrypt')}
        pressed={value.encrypt}
        // Encrypting turns signing on with it, the way other clients pair
        // them: an encrypted message nobody can attribute is the odd case.
        onToggle={() =>
          onChange({ encrypt: !value.encrypt, sign: value.encrypt ? value.sign : true })
        }
      />
      <Toggle
        icon="check"
        label={t('compose.sign')}
        pressed={value.sign}
        onToggle={() => onChange({ ...value, sign: !value.sign })}
      />
    </>
  )
}

/**
 * What the switches mean for this message right now: who has no key, whether
 * the key needs unlocking first, and the two things worth knowing before
 * sending — the subject stays readable, and nothing is saved as a draft.
 */
export function SecurityNotices({
  accountId,
  value,
  recipients,
}: {
  accountId: string
  value: SecureOptions
  recipients: EmailAddress[]
}) {
  useSyncExternalStore(onKeysChanged, keysVersion)
  const missing = useMissingKeys(accountId, value.encrypt, recipients)
  const locked = value.sign && unlockedKeys(accountId).length === 0
  const [pass, setPass] = useState('')
  const [wrong, setWrong] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!value.encrypt && !value.sign) return null
  return (
    <div role="status" className="space-y-1 border-t border-line px-4 py-2 text-xs text-ink-muted">
      {missing.length > 0 && (
        <p className="text-danger">{tf('compose.noKeyFor', { recipients: missing.join(', ') })}</p>
      )}
      {locked && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!pass) return
            setBusy(true)
            setWrong(false)
            void unlockOwnKeys(accountId, pass)
              .then((n) => {
                if (n) setPass('')
                else setWrong(true)
              })
              .finally(() => setBusy(false))
          }}
        >
          <span>{t('compose.keyLocked')}</span>
          <input
            type="password"
            aria-label={t('pgp.passphrase')}
            placeholder={t('pgp.passphrase')}
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            className="min-w-0 flex-1 rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink"
          />
          <button
            type="submit"
            disabled={busy || !pass}
            className="font-medium text-accent hover:underline disabled:opacity-50"
          >
            {busy ? t('pgp.unlocking') : t('pgp.unlock')}
          </button>
          {wrong && <span className="text-danger">{t('pgp.wrongPassphrase')}</span>}
        </form>
      )}
      {value.encrypt && <p>{t('compose.encryptNotes')}</p>}
    </div>
  )
}
