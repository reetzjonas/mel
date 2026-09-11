import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Account } from '../../domain/account'
import { t } from '../../lib/i18n'
import { formatRelativePast } from '../../lib/dates'
import { db } from '../../storage/db'
import { isSubscribed } from '../../services/webPush'
import { getSyncStatus, subscribeSyncStatus, type SyncMode } from '../../sync/scheduler'
import { useSettingsRoute } from '../settings/navigation'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

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
  const { open: openSettings } = useSettingsRoute()
  const online = useOnline()
  const webPushActive = useWebPushActive(account.capabilities.webPush)
  useTicker(30_000)

  // toArray + filter in JS on purpose: a Dexie .filter() is a cursor read and
  // those bypass the crypto middleware on payload-carrying tables. The outbox
  // is short-lived and tiny, so reading it whole costs nothing.
  const outbox = useLiveQuery(
    async () => {
      const rows = await db.outbox.where('accountId').equals(account.id).toArray()
      return {
        queued: rows.filter((r) => r.status !== 'failed').length,
        // Failed ones used to be filtered out entirely, so an action that never
        // reached the server vanished without a trace — and the next sync
        // silently reverted whatever the user had asked for.
        failed: rows.filter((r) => r.status === 'failed').length,
      }
    },
    [account.id],
    { queued: 0, failed: 0 },
  )
  const queued = outbox.queued

  let label: string
  let icon: IconName = MODE_ICON[status.mode]
  let tone = 'text-ink-muted'
  if (!online) {
    label = t('sync.offline')
    icon = 'offline'
  } else if (status.error) {
    label = status.error.kind === 'auth' ? t('sync.error.auth') : t('sync.error.unreachable')
    icon = 'offline'
    tone = 'text-danger'
  } else if (status.syncing) {
    label = t('sync.syncing')
  } else if (status.mode === 'push') {
    label = t('sync.push')
  } else if (status.mode === 'poll') {
    label = `${t('sync.poll')} ${Math.round(status.intervalMs / 1000)} s`
  } else if (status.mode === 'connecting') {
    label = t('sync.connecting')
  } else {
    label = t('sync.paused')
  }

  /*
   * The second line is always rendered, even empty: this box is pinned to the
   * bottom of the sidebar, so a line appearing or vanishing would shove the
   * folder list around every time the sync state changed.
   *
   * Web Push only earns a mention once a subscription really exists, not when
   * the server merely supports one. The last sync time is deliberately not
   * shown while pushing — it says "just now" forever and reads as noise; it
   * lives in the tooltip instead.
   */
  let detail = ''
  let detailTone = ''
  if (outbox.failed > 0) {
    detail =
      outbox.failed === 1 ? t('sync.failed.one') : `${outbox.failed} ${t('sync.failed.many')}`
    detailTone = 'text-danger'
  } else if (queued > 0) {
    detail = queued === 1 ? t('sync.queued.one') : `${queued} ${t('sync.queued.many')}`
  } else if (status.error) {
    detail = t('sync.error.hint')
  } else if (webPushActive) {
    detail = t('sync.webPush')
  } else if (status.lastSyncAt && status.mode !== 'push') {
    detail = formatRelativePast(status.lastSyncAt)
  }

  const tooltip = [
    status.lastSyncAt ? `${t('sync.lastSync')}: ${formatRelativePast(status.lastSyncAt)}` : null,
    status.error?.detail,
  ]
    .filter(Boolean)
    .join('\n')

  // Links into the capability list: this bar is where people look first when
  // something seems off, and "why is the calendar missing" is answered there.
  const bar = (
    <button
      type="button"
      onClick={() => openSettings('account')}
      className="block w-full shrink-0 border-t border-line px-3 py-2 text-left text-[11px] text-ink-subtle transition-colors hover:bg-surface-2"
      data-testid="sync-status"
    >
      <span className="flex items-center gap-1.5">
        <Icon
          name={icon}
          size={12}
          className={status.syncing ? 'shrink-0 animate-spin' : 'shrink-0'}
        />
        <span className={`truncate font-medium ${tone}`}>{label}</span>
      </span>
      <span
        className={`mt-0.5 block h-[14px] truncate ${detailTone || (queued > 0 ? 'text-honey' : '')}`}
      >
        {detail}
      </span>
    </button>
  )

  return tooltip ? <Tooltip label={tooltip}>{bar}</Tooltip> : bar
}
