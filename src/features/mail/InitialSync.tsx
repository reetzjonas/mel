import { t } from '../../lib/i18n'
import type { FullSyncProgress } from '../../sync/progress'
import { ThreadListSkeleton } from '../../ui/Skeleton'
import { progressLabel } from './progressLabel'

/**
 * What an empty folder shows while the first full fetch is still running.
 *
 * Not the "No messages" empty state: on a large account that fetch takes
 * minutes, and for all of them the folder was claiming to be empty when the
 * truth was that we had not looked yet. Skeleton rows rather than an icon,
 * because rows really are about to appear there.
 */
export function InitialSync({ progress }: { progress: FullSyncProgress }) {
  const count = progressLabel(progress)
  return (
    <div className="flex h-full flex-col">
      <div className="animate-fade space-y-1 px-6 pt-6 pb-3 text-center">
        <p className="text-sm font-medium text-ink-muted">{t('sync.initial')}</p>
        {count && <p className="text-xs text-ink-subtle">{count}</p>}
        <p className="text-xs text-ink-subtle">{t('sync.initial.hint')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" aria-hidden>
        <ThreadListSkeleton />
      </div>
    </div>
  )
}
