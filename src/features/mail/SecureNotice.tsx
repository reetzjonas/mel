import { useState, type ReactNode } from 'react'
import { formatFingerprint, type SignatureCheck } from '../../domain/pgp'
import { t, tf } from '../../lib/i18n'
import { unlockOwnKeys } from '../../services/pgpKeys'
import type { SecureView } from '../../services/pgpRead'
import { Icon, type IconName } from '../../ui/Icon'
import { inputClass, primaryButtonClass } from '../../ui/styles'
import { useSettingsRoute } from '../settings/navigation'

type Tone = 'ok' | 'neutral' | 'danger'

const toneClass: Record<Tone, string> = {
  ok: 'bg-accent-wash text-ink',
  neutral: 'bg-surface-2 text-ink-muted',
  danger: 'bg-danger-wash text-danger',
}

export function Band({ tone, icon, children }: { tone: Tone; icon: IconName; children: ReactNode }) {
  return (
    <div
      role="status"
      className={`flex gap-2 border-t border-line px-4 py-2 text-sm lg:px-6 ${toneClass[tone]}`}
    >
      <Icon
        name={icon}
        size={14}
        className={`mt-0.5 shrink-0 ${tone === 'ok' ? 'text-accent' : ''}`}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function signatureLine(sig: SignatureCheck | null, encrypted: boolean): ReactNode {
  if (!sig) return encrypted ? <p className="text-xs opacity-80">{t('pgp.notSigned')}</p> : null
  if (sig.state === 'valid') {
    return (
      <p
        className="font-medium"
        title={`${t('pgp.fingerprint')}: ${formatFingerprint(sig.fingerprint)}`}
      >
        {sig.own ? t('pgp.signedByYou') : tf('pgp.signedBy', { signer: sig.signer })}
      </p>
    )
  }
  if (sig.state === 'unknownKey') return <p className="text-xs opacity-80">{t('pgp.unknownKey')}</p>
  return null
}

/**
 * What OpenPGP says about the open message (issue #63): encrypted or not, who
 * signed it and whether that holds, or what is missing to find out.
 *
 * A signature that does not match gets a band of its own in the danger tone.
 * Everything else shares one band, since "encrypted, signed by Bob" is one
 * fact to the reader, not two.
 */
export function SecureNotice({
  accountId,
  view,
}: {
  accountId: string
  view: SecureView | 'pending'
}) {
  const { open: openSettings } = useSettingsRoute()
  if (view === 'pending') return null

  if (view.state === 'locked') return <UnlockBand accountId={accountId} />
  if (view.state === 'noKey') {
    return (
      <Band tone="neutral" icon="lock">
        <p className="font-medium text-ink">{t('pgp.lockedBand')}</p>
        <p className="text-xs">{t('pgp.noKeyHint')}</p>
        <button
          type="button"
          onClick={() => openSettings('security', 'pgp')}
          className="mt-1 text-xs font-medium text-accent hover:underline"
        >
          {t('pgp.openSettings')}
        </button>
      </Band>
    )
  }
  if (view.state === 'undecryptable') {
    return (
      <Band tone="neutral" icon="lock">
        <p>{t('pgp.undecryptable')}</p>
      </Band>
    )
  }
  if (view.state === 'unavailable') {
    return (
      <Band tone="neutral" icon="offline">
        <p>{t('pgp.unavailable')}</p>
      </Band>
    )
  }

  const { encrypted, signature, partial } = view
  if (signature?.state === 'invalid') {
    return (
      <>
        <Band tone="danger" icon="warning">
          <p className="font-medium">{t('pgp.invalidSignature')}</p>
          <p className="text-xs opacity-80">{t('pgp.invalidSignatureHint')}</p>
        </Band>
        {encrypted && (
          <Band tone="neutral" icon="lock">
            <p>{t('pgp.encrypted')}</p>
          </Band>
        )}
      </>
    )
  }
  return (
    <Band
      tone={encrypted || signature?.state === 'valid' ? 'ok' : 'neutral'}
      icon={encrypted ? 'lock' : 'check'}
    >
      {encrypted && <p className="font-medium">{t('pgp.encrypted')}</p>}
      {signatureLine(signature, encrypted)}
      {partial && <p className="text-xs opacity-80">{t('pgp.partial')}</p>}
      {encrypted && <p className="text-xs opacity-80">{t('pgp.subjectClear')}</p>}
    </Band>
  )
}

function UnlockBand({ accountId }: { accountId: string }) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState(false)
  return (
    <Band tone="neutral" icon="lock">
      <p className="font-medium text-ink">{t('pgp.lockedBand')}</p>
      <p className="text-xs">{t('pgp.lockedHint')}</p>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!pass) return
          setBusy(true)
          setWrong(false)
          // A right passphrase re-runs the check by itself (the keys moved);
          // only a wrong one has anything to show here.
          void unlockOwnKeys(accountId, pass)
            .then((n) => {
              if (!n) setWrong(true)
              else setPass('')
            })
            .finally(() => setBusy(false))
        }}
      >
        <input
          type="password"
          aria-label={t('pgp.passphrase')}
          placeholder={t('pgp.passphrase')}
          autoComplete="current-password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          className={`${inputClass} max-w-64 flex-1`}
        />
        <button type="submit" disabled={busy || !pass} className={primaryButtonClass}>
          {busy ? t('pgp.unlocking') : t('pgp.unlock')}
        </button>
      </form>
      {wrong && <p className="mt-1 text-xs text-danger">{t('pgp.wrongPassphrase')}</p>}
    </Band>
  )
}
