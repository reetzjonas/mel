import { useEffect, useState } from 'react'
import { formatFingerprint, type KeyInfo } from '../../domain/pgp'
import { t } from '../../lib/i18n'

const dateOnly = (iso: string) => new Date(iso).toLocaleDateString()

/* Read at render on purpose: the expiry is a date, and a card left open
   across midnight going stale by a day is harmless. */
const isPast = (iso: string) => new Date(iso).getTime() < Date.now()

/** The facts that identify a key; the fingerprint is the one to compare. */
export function KeyFacts({ info, userIds }: { info: KeyInfo; userIds?: boolean }) {
  const expired = info.expires !== null && isPast(info.expires)
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {userIds && info.userIds.length > 0 && (
        <>
          <dt className="text-ink-muted">{t('pgp.userIds')}</dt>
          <dd className="break-words">{info.userIds.join(', ')}</dd>
        </>
      )}
      <dt className="text-ink-muted">{t('pgp.fingerprint')}</dt>
      <dd className="font-mono break-all">{formatFingerprint(info.fingerprint)}</dd>
      <dt className="text-ink-muted">{t('pgp.created')}</dt>
      <dd>
        {dateOnly(info.created)} · {info.algorithm}
      </dd>
      <dt className="text-ink-muted">{t('pgp.expires')}</dt>
      <dd className={expired || info.revoked ? 'text-danger' : ''}>
        {info.revoked
          ? t('pgp.revoked')
          : info.expires
            ? `${dateOnly(info.expires)}${expired ? ` (${t('pgp.expired')})` : ''}`
            : t('pgp.never')}
      </dd>
    </dl>
  )
}

/**
 * The facts of a public key given as armored text, read once the library has
 * loaded. Nothing while it loads, and nothing for a key it cannot read: the
 * card already says what kind of key it is.
 */
export function ArmoredKeyFacts({ armored }: { armored: string }) {
  const [info, setInfo] = useState<{ armored: string; info: KeyInfo | null } | null>(null)
  useEffect(() => {
    let alive = true
    void import('../../services/pgpKeys')
      .then(({ describeKey }) => describeKey(armored))
      .catch(() => null)
      .then((result) => alive && setInfo({ armored, info: result }))
    return () => {
      alive = false
    }
  }, [armored])
  const current = info?.armored === armored ? info.info : null
  return current ? <KeyFacts info={current} userIds /> : null
}
