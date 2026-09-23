import { useEffect, useState, useSyncExternalStore } from 'react'
import type { EmailBody, EmailHeader } from '../../domain/email'
import { pgpKind, type PgpKind } from '../../domain/pgp'
import { keysVersion, onKeysChanged } from '../../services/pgpKeys'
import type { SecureView } from '../../services/pgpRead'

export interface SecureState {
  kind: PgpKind | null
  /** 'pending' while the check runs; null when there is nothing to say. */
  view: SecureView | null | 'pending'
}

/**
 * What OpenPGP has to say about the open message (issue #63).
 *
 * Re-run whenever a key is unlocked, imported or removed, so typing the
 * passphrase into the band opens the message in place. The library is only
 * fetched for a message that turns out to need it.
 */
export function useSecureMessage(
  accountId: string,
  email: EmailHeader,
  body: EmailBody | null | 'loading',
  ownEmail: string,
): SecureState {
  const version = useSyncExternalStore(onKeysChanged, keysVersion)
  const ready = body !== 'loading' && body !== null ? body : null
  const kind = ready ? pgpKind(ready) : null
  const key = `${accountId}:${email.id}:${version}`
  const [done, setDone] = useState<{ key: string; view: SecureView | null } | null>(null)
  const sender = email.from.length === 1 ? email.from[0]!.email : null

  useEffect(() => {
    if (!ready || !kind) return
    let alive = true
    void import('../../services/pgpRead')
      .then(({ openSecure }) =>
        openSecure(accountId, {
          emailId: email.id,
          body: ready,
          kind,
          // Several From addresses: whose card would the key come from?
          // Better unchecked than checked against the wrong person.
          sender,
          fromSelf: Boolean(sender && sender.toLowerCase() === ownEmail.toLowerCase()),
        }),
      )
      .catch((): SecureView => ({ state: 'unavailable' }))
      .then((view) => alive && setDone({ key, view }))
    return () => {
      alive = false
    }
    // `ready` changes identity with every fetch of the same body; the key and
    // kind are what decide whether there is anything new to check.
    // oxlint-disable-next-line exhaustive-deps
  }, [key, kind])

  if (!kind) return { kind: null, view: null }
  return { kind, view: done?.key === key ? done.view : 'pending' }
}
