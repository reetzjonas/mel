import { currentLocale, t } from '../../lib/i18n'
import type { FullSyncProgress } from '../../sync/progress'

const number = new Intl.NumberFormat(currentLocale)

/**
 * "12,500 of 36,000 messages", or without the second half when the server
 * declined to count. One function so the list and the sidebar cannot drift
 * into phrasing the same number two different ways.
 *
 * Null before the first page has landed, when the honest count is zero and
 * the total is still unknown: "0 messages" reads like an answer, and at that
 * moment we have not got one.
 */
export function progressLabel(p: FullSyncProgress): string | null {
  if (p.total === null && p.done === 0) return null
  const done = number.format(p.done)
  return p.total === null
    ? `${done} ${t('sync.initial.messages')}`
    : `${done} ${t('sync.initial.of')} ${number.format(p.total)} ${t('sync.initial.messages')}`
}
