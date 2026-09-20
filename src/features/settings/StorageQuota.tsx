import { useEffect, useState } from 'react'
import type { StorageQuota } from '../../domain/quota'
import { t } from '../../lib/i18n'
import { storageQuota } from '../../services/quota'
import { Icon } from '../../ui/Icon'
import { Skeleton } from '../../ui/Skeleton'
import { Tooltip } from '../../ui/Tooltip'
import { useSettingsRoute } from './navigation'
import {
  FIRST_READ_MS,
  FULL_ENOUGH,
  REFRESH_MS,
  RETRY_MS,
  percentLabel,
  quotaLabel,
  usedFraction,
} from './quota'

/**
 * The quota as the server last reported it: undefined until it has answered,
 * null when nothing limits the account.
 *
 * Those two are kept apart because they read as opposite claims — "not known
 * yet" rendered as "no limit" tells the user something false for as long as the
 * request is in flight.
 *
 * Read from the server rather than mirrored into IndexedDB: it is one number,
 * it means nothing offline, and it moves with every write the account makes in
 * any of the four apps. Nothing here ever shows an error: this is
 * informational, and an error in its place would be louder than the fact.
 */
function useStorageQuota(
  accountId: string | null,
  enabled: boolean,
  delayMs: number,
): StorageQuota | null | undefined {
  const [quota, setQuota] = useState<StorageQuota | null | undefined>(undefined)

  useEffect(() => {
    if (!accountId || !enabled) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const read = () =>
      void storageQuota(accountId).then(
        (q) => {
          if (!cancelled) setQuota(q)
        },
        () => {
          // A read that failed says nothing about the account, so it must not
          // be written down as "nothing limits this". Keep what we had — or
          // keep waiting — and come back sooner than the slow refresh would.
          if (!cancelled) retry = setTimeout(read, RETRY_MS)
        },
      )
    let repeat: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
      read()
      repeat = setInterval(read, REFRESH_MS)
    }, delayMs)
    return () => {
      cancelled = true
      clearTimeout(first)
      clearTimeout(retry)
      clearInterval(repeat)
    }
  }, [accountId, enabled, delayMs])

  return enabled ? quota : null
}

function Bar({ fraction, className }: { fraction: number; className: string }) {
  return (
    <span className={`block overflow-hidden rounded-full bg-surface-2 ${className}`}>
      {/* A sliver rather than nothing at all: a bar that renders empty at 0.4%
          says "unused", which is a different claim from "barely used". */}
      <span
        className={`block h-full rounded-full transition-[width] duration-300 ${
          fraction >= FULL_ENOUGH ? 'bg-danger' : 'bg-accent'
        }`}
        style={{ width: `${Math.max(fraction * 100, fraction > 0 ? 2 : 0)}%` }}
      />
    </span>
  )
}

/**
 * A warning in the app shell header, and only once storage is nearly gone.
 *
 * The figure is account-wide — the server counts mail, files, calendars,
 * contacts and filter scripts into one number — so the shell header is the only
 * chrome that fits it; all four apps share it. But a permanent meter reading
 * "2 %" is noise in the one piece of chrome every screen carries, so nothing is
 * shown until the number is actually worth acting on. The full figure lives in
 * Settings → Account, which this opens.
 */
export function StorageWarning({ accountId, enabled }: { accountId: string; enabled: boolean }) {
  const quota = useStorageQuota(accountId, enabled, FIRST_READ_MS)
  const { open } = useSettingsRoute()
  if (!quota) return null

  const fraction = usedFraction(quota)
  if (fraction < FULL_ENOUGH) return null

  const label = `${t('quota.nearlyFull')}: ${quotaLabel(quota)}`
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={() => open('account', 'storage')}
        className="flex min-h-11 items-center gap-1.5 rounded-control bg-danger-wash px-2 py-1.5 text-danger transition-colors hover:bg-danger hover:text-canvas sm:min-h-0"
      >
        <Icon name="warning" size={15} />
        <span className="text-xs font-medium tabular-nums">{percentLabel(fraction)}</span>
      </button>
    </Tooltip>
  )
}

/** The full figure in Settings → Account. */
export function StorageSetting({ accountId, enabled }: { accountId: string; enabled: boolean }) {
  // Opened by hand, long after the startup burst this defers for elsewhere, so
  // there is nothing to wait out here.
  const quota = useStorageQuota(accountId, enabled, 0)
  if (quota === undefined) return <Skeleton className="h-4 w-56" />
  if (!quota) return <p className="text-sm text-ink-muted">{t('quota.none')}</p>

  const fraction = usedFraction(quota)
  return (
    <div className="space-y-2">
      <Bar fraction={fraction} className="h-2 w-full" />
      <p className="text-sm">
        {quotaLabel(quota)}
        <span className="text-ink-muted"> · {percentLabel(fraction)}</span>
      </p>
      <p className="text-xs text-ink-subtle">{t('quota.scope')}</p>
    </div>
  )
}
