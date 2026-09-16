import type { StorageQuota } from '../../domain/quota'
import { formatBytes } from '../../lib/bytes'
import { t } from '../../lib/i18n'

/**
 * Both delays keep this out of the way of the work that matters.
 *
 * The figure started out refreshing on every completed sync, which put a JMAP
 * request beside every tick; that alone cost the e2e suite a test or two per
 * full run, each time a different one, always on a timeout. Reading it once per
 * mount was not enough either, because that one read lands in the startup
 * burst, and the server allows `maxConcurrentRequests: 4` — the initial sync
 * wants all of them. So the first read waits for the burst to pass.
 *
 * Nothing is lost by waiting: storage fills over days, and this is a warning
 * about being nearly full, not a live counter.
 */
export const FIRST_READ_MS = 5_000
export const REFRESH_MS = 5 * 60_000
/** After a failed read, which is a blip rather than an answer. */
export const RETRY_MS = 5_000

/** Nearly full, and worth saying so in colour rather than only in numbers. */
export const FULL_ENOUGH = 0.9

export function usedFraction(q: StorageQuota): number {
  return q.limit > 0 ? Math.min(1, q.used / q.limit) : 0
}

/** "12 %", or "< 1 %" — a rounded zero on a non-empty account reads as broken. */
export function percentLabel(fraction: number): string {
  const percent = fraction * 100
  if (percent > 0 && percent < 1) return '< 1 %'
  return `${Math.round(percent)} %`
}

/** "127 KB of 1 GB used". One function so the meter and the setting agree. */
export function quotaLabel(q: StorageQuota): string {
  return `${formatBytes(q.used)} ${t('quota.of')} ${formatBytes(q.limit)} ${t('quota.used')}`
}
