import { useLiveQuery } from 'dexie-react-hooks'
import { useUi } from '../../app/store'
import { imageSenders } from '../../services/imageSenders'

/**
 * The addresses whose images may load, or `undefined` while that is still
 * being read. The distinction matters: "not known yet" is not "not allowed" —
 * a reader that treats it as a denial renders a blocked message first and has
 * to replace it a tick later.
 */
export function useImageSenders(accountId: string | undefined): string[] | undefined {
  const unlockVersion = useUi((s) => s.unlockVersion)
  const result = useLiveQuery(
    async () => ({
      accountId,
      senders: accountId ? await imageSenders(accountId) : [],
    }),
    [accountId, unlockVersion],
  )
  // A previous account's query result must never grant permission here.
  if (!result || result.accountId !== accountId) return undefined
  return result.senders
}
