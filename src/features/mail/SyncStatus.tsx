import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Account } from '../../domain/account'
import { t } from '../../lib/i18n'
import { formatRelativePast } from '../../lib/dates'
import { db } from '../../storage/db'
import { isSubscribed } from '../../services/webPush'
import { getSyncStatus, subscribeSyncStatus, type SyncMode } from '../../sync/scheduler'
import { Icon, type IconName } from '../../ui/Icon'

function useSyncStatus(accountId: string) {
  return useSyncExternalStore(
    subscribeSyncStatus,
    () => getSyncStatus(accountId),
    () => getSyncStatus(accountId),
  )
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

/** Whether a Web Push subscription actually exists, not merely that it could. */
function useWebPushActive(enabled: boolean): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!enabled) return setActive(false)
    let cancelled = false
    void isSubscribed().then((v) => {
      if (!cancelled) setActive(v)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return active
}

/** Re-render on a timer so "synced 2 min ago" doesn't go stale while idle. */
function useTicker(everyMs: number) {
  const [, bump] = useState(0)
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
}

const MODE_ICON: Record<SyncMode, IconName> = {
  push: 'bolt',
  poll: 'refresh',
  connecting: 'refresh',
  stopped: 'refresh',
}

/**
 * Pinned to the bottom of the folder sidebar: how updates are arriving right
 * now (push vs. polling), when we last heard from the server, and whether
 * anything is still queued locally.
 */
export function SyncStatus({ account }: { account: Account }) {
  const status = useSyncStatus(account.id)
  const online = useOnline()
  const webPushActive = useWebPushActive(account.capabilities.webPush)
  useTicker(30_000)

  // toArray + filter in JS on purpose: a Dexie .filter() is a cursor read and
  // those bypass the crypto middleware on payload-carrying tables. The outbox
  // is short-lived and tiny, so reading it whole costs nothing.
  const queued = useLiveQuery(
    async () => {
      const rows = await db.outbox.where('accountId').equals(account.id).toArray()
      return rows.filter((r) => r.status !== 'failed').length
    },
    [account.id],
    0,
  )

  let label: string
  let icon: IconName = MODE_ICON[status.mode]
  if (!online) {
    label = t('sync.offline')
    icon = 'offline'
  } else if (status.syncing) {
    label = t('sync.syncing')
  } else if (status.mode === 'push') {
    label = t('sync.push')
  } else if (status.mode === 'poll') {
    label = `${t('sync.poll')} ${Math.round(status.intervalMs / 1000)} s`
  } else if (status.mode === 'connecting') {
    label = t('sync.connecting')
  } else {
    label = t('sync.paused')
  }

  // Web Push keeps notifications flowing with the app closed, which is a
  // different thing from the live connection above — and it only earns a
  // mention once a subscription really exists, not when the server merely
  // supports one.
  const detail = [
    status.lastSyncAt ? formatRelativePast(status.lastSyncAt) : null,
    webPushActive ? t('sync.webPush') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-ink-subtle"
      data-testid="sync-status"
    >
      <span className="flex items-center gap-1.5">
        <Icon
          name={icon}
          size={12}
          className={status.syncing ? 'shrink-0 animate-spin' : 'shrink-0'}
        />
        <span className="truncate font-medium text-ink-muted">{label}</span>
      </span>
      {detail && <span className="mt-0.5 block truncate">{detail}</span>}
      {queued > 0 && (
        <span className="mt-0.5 block truncate text-honey">
          {queued === 1 ? t('sync.queued.one') : `${queued} ${t('sync.queued.many')}`}
        </span>
      )}
    </div>
  )
}
