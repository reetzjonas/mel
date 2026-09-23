import { useLiveQuery } from 'dexie-react-hooks'
import { useRef, useState, useSyncExternalStore } from 'react'
import type { KeyInfo, OwnKey } from '../../domain/pgp'
import { KeyFacts } from '../pgp/KeyFacts'
import { t } from '../../lib/i18n'
import { saveBlob } from '../../lib/saveBlob'
import {
  importOwnKey,
  inspectSecretKey,
  isUnlocked,
  keysVersion,
  lockOwnKeys,
  onKeysChanged,
  ownKeys,
  publicArmor,
  removeOwnKey,
  type SecretKeyCheck,
} from '../../services/pgpKeys'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'

function KeyCard({ accountId, own }: { accountId: string; own: OwnKey }) {
  useSyncExternalStore(onKeysChanged, keysVersion)
  const open = isUnlocked(accountId, own.fingerprint)
  const [removing, setRemoving] = useState(false)
  const name = own.userIds[0] ?? own.fingerprint.slice(-16)
  const fileBase = own.fingerprint.slice(-16).toUpperCase()
  return (
    <li className="space-y-2 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 text-sm font-medium break-words">
          {own.userIds.join(', ') || name}
        </span>
        <span className={`text-xs ${open ? 'text-accent' : 'text-ink-muted'}`}>
          {open ? t('pgp.unlocked') : t('pgp.locked')}
        </span>
      </div>
      <KeyFacts info={own} />
      <div className="flex flex-wrap gap-2">
        {open && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => lockOwnKeys(accountId)}
          >
            {t('pgp.lock')}
          </button>
        )}
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() =>
            void publicArmor(own).then((armor) =>
              saveBlob(new Blob([armor], { type: 'application/pgp-keys' }), `${fileBase}.pub.asc`),
            )
          }
        >
          {t('pgp.exportPublic')}
        </button>
        {/* The stored form is still sealed by its own passphrase, so this
            hands out exactly what was imported — nothing mel can open alone. */}
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() =>
            saveBlob(
              new Blob([own.armored], { type: 'application/pgp-keys' }),
              `${fileBase}.secret.asc`,
            )
          }
        >
          {t('pgp.exportSecret')}
        </button>
        <button
          type="button"
          className="rounded-control border border-danger px-3 py-2 text-sm text-danger transition-colors hover:bg-danger-wash"
          onClick={() => setRemoving(true)}
        >
          {t('pgp.remove')}
        </button>
      </div>
      {removing && (
        <ConfirmDialog
          title={t('pgp.removeTitle')}
          message={t('pgp.removeBody')}
          cancelLabel={t('pgp.cancel')}
          confirmLabel={t('pgp.remove')}
          onClose={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false)
            void removeOwnKey(accountId, own.fingerprint)
          }}
        />
      )}
    </li>
  )
}

/**
 * Importing a key: paste or pick a file, see what it is, then give the
 * passphrase. Two steps because the second depends on the first — a
 * protected key needs its own passphrase checked, an unprotected one needs a
 * new one chosen (mel does not store it otherwise), and a public key needs
 * telling apart before anyone types a passphrase for it.
 */
function ImportForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [text, setText] = useState('')
  const [binary, setBinary] = useState<Uint8Array | null>(null)
  const [check, setCheck] = useState<Extract<SecretKeyCheck, { info: KeyInfo }> | null>(null)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const input = () => binary ?? text.trim()

  const inspect = async (value: string | Uint8Array) => {
    setError(null)
    setBusy(true)
    const result = await inspectSecretKey(value).finally(() => setBusy(false))
    if (result.kind === 'invalid') setError(t('pgp.invalid'))
    else if (result.kind === 'public') setError(t('pgp.isPublic'))
    else setCheck(result)
  }

  if (!check) {
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          void inspect(input())
        }}
      >
        <label className="block text-xs text-ink-muted" htmlFor="pgp-import">
          {t('pgp.importPaste')}
        </label>
        <textarea
          id="pgp-import"
          className={`${inputClass} h-28 font-mono text-xs`}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setBinary(null)
          }}
          placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
        />
        <input
          ref={file}
          type="file"
          accept=".asc,.gpg,.pgp,.key,application/pgp-keys"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            void f.arrayBuffer().then((buf) => {
              const bytes = new Uint8Array(buf)
              const asText = new TextDecoder().decode(bytes)
              // An armored file is text; a GnuPG export without --armor is not.
              if (asText.includes('-----BEGIN PGP')) {
                setText(asText)
                setBinary(null)
                void inspect(asText.trim())
              } else {
                setText('')
                setBinary(bytes)
                void inspect(bytes)
              }
            })
          }}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !text.trim()} className={primaryButtonClass}>
            {t('pgp.check')}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => file.current?.click()}
          >
            {t('pgp.chooseFile')}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onDone}>
            {t('pgp.cancel')}
          </button>
        </div>
      </form>
    )
  }

  const unprotected = check.kind === 'unprotected'
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        if (unprotected && pass !== confirm) {
          setError(t('pgp.mismatch'))
          return
        }
        setBusy(true)
        void importOwnKey(accountId, input(), pass)
          .then((r) => {
            if (r === 'ok') onDone()
            else setError(r === 'wrongPassphrase' ? t('pgp.wrongPassphrase') : t('pgp.invalid'))
          })
          .finally(() => setBusy(false))
      }}
    >
      <KeyFacts info={check.info} />
      <p className="text-sm text-ink-muted">
        {unprotected ? t('pgp.unprotectedAsk') : t('pgp.protectedAsk')}
      </p>
      <input
        type="password"
        className={inputClass}
        aria-label={t('pgp.passphrase')}
        placeholder={t('pgp.passphrase')}
        autoComplete={unprotected ? 'new-password' : 'current-password'}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      {unprotected && (
        <input
          type="password"
          className={inputClass}
          aria-label={t('pgp.confirm')}
          placeholder={t('pgp.confirm')}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !pass} className={primaryButtonClass}>
          {busy ? t('pgp.importing') : t('pgp.import')}
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onDone}>
          {t('pgp.cancel')}
        </button>
      </div>
    </form>
  )
}

/** Settings → Security: the user's own OpenPGP key (issue #63). */
export function PgpKeySetting({ accountId }: { accountId: string }) {
  const keys = useLiveQuery(() => ownKeys(accountId), [accountId])
  const [importing, setImporting] = useState(false)
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">{t('pgp.hint')}</p>
      {keys && keys.length > 0 ? (
        <ul className="space-y-2">
          {keys.map((k) => (
            <KeyCard key={k.fingerprint} accountId={accountId} own={k} />
          ))}
        </ul>
      ) : (
        keys && !importing && <p className="text-sm text-ink-muted">{t('pgp.none')}</p>
      )}
      {importing ? (
        <ImportForm accountId={accountId} onDone={() => setImporting(false)} />
      ) : (
        <button type="button" className={secondaryButtonClass} onClick={() => setImporting(true)}>
          {t('pgp.import')}
        </button>
      )}
    </div>
  )
}
