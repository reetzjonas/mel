import { useLiveQuery } from 'dexie-react-hooks'
import { t, tf } from '../../lib/i18n'
import { ownKeys } from '../../services/pgpKeys'
import type { SecureProblem } from '../../services/pgpWrite'

/** Whether the user has an OpenPGP key here at all: without one there is nothing to offer. */
export function useHasOwnKey(accountId: string): boolean {
  const keys = useLiveQuery(() => ownKeys(accountId), [accountId])
  return Boolean(keys?.length)
}

/** What a failed secure send was about, in words. */
export function secureProblemText(problem: SecureProblem): string {
  if (problem.kind === 'missingKeys')
    return tf('compose.noKeyFor', { recipients: problem.addresses.join(', ') })
  if (problem.kind === 'locked') return t('compose.keyLocked')
  return t('compose.noOwnKey')
}
