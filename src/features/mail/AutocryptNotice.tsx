import { useEffect, useState } from 'react'
import { useUi } from '../../app/store'
import type { EmailBody, EmailHeader } from '../../domain/email'
import { formatFingerprint } from '../../domain/pgp'
import { t, tf } from '../../lib/i18n'
import type { AutocryptOffer } from '../../services/autocrypt'
import { Band } from './SecureNotice'

/**
 * A public key the sender put in the message's Autocrypt header (issue
 * #101), offered for their contact card rather than stored silently: a key
 * decides who can read what the user writes, so saving one is the user's
 * call, with the fingerprint in front of them.
 */
export function AutocryptNotice({
  accountId,
  email,
  body,
  ownEmail,
}: {
  accountId: string
  email: EmailHeader
  body: EmailBody
  ownEmail: string
}) {
  const { showSnackbar } = useUi()
  const sender = email.from.length === 1 ? email.from[0]! : null
  const fromSelf = sender?.email.toLowerCase() === ownEmail.toLowerCase()
  const values = body.autocrypt
  const [result, setResult] = useState<{ id: string; offer: AutocryptOffer | null } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!sender || fromSelf || !values?.length) return
    let alive = true
    void import('../../services/autocrypt')
      .then(({ autocryptOffer }) => autocryptOffer(accountId, values, sender))
      .catch(() => null)
      .then((offer) => alive && setResult({ id: email.id, offer }))
    return () => {
      alive = false
    }
    // The header values arrive with the body, so the message id says it all.
    // oxlint-disable-next-line exhaustive-deps
  }, [accountId, email.id, Boolean(values?.length), fromSelf])

  const offer = result?.id === email.id ? result.offer : null
  if (!offer) return null
  const who = offer.sender.name?.trim() || offer.sender.email
  const fingerprint = (
    <p className="mt-1 font-mono text-xs break-all">
      {t('pgp.fingerprint')}: {formatFingerprint(offer.info.fingerprint)}
    </p>
  )

  if (offer.kind === 'differs') {
    return (
      <Band tone="danger" icon="warning">
        <p className="font-medium">{tf('autocrypt.differs', { sender: who })}</p>
        <p className="text-xs">{tf('autocrypt.differsHint', { sender: who })}</p>
        {fingerprint}
      </Band>
    )
  }

  const add = () => {
    setBusy(true)
    void import('../../services/autocrypt')
      .then(({ saveAutocryptKey }) => saveAutocryptKey(accountId, offer))
      .then(
        () => {
          setResult({ id: email.id, offer: null })
          showSnackbar({ message: tf('autocrypt.added', { sender: who }) })
        },
        () => showSnackbar({ message: t('autocrypt.addFailed') }),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Band tone="neutral" icon="key">
      <p className="font-medium text-ink">{tf('autocrypt.offer', { sender: who })}</p>
      <p className="text-xs">{tf('autocrypt.offerHint', { sender: who })}</p>
      {fingerprint}
      <button
        type="button"
        disabled={busy}
        onClick={add}
        className="mt-1 text-xs font-medium text-accent hover:underline disabled:opacity-50"
      >
        {busy ? t('autocrypt.adding') : t('autocrypt.add')}
      </button>
    </Band>
  )
}
