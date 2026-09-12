/**
 * How far the first full fetch of a mailbox has got.
 *
 * Its own module rather than a field on the scheduler's `SyncStatus`: the
 * engine is what knows this, and the scheduler already imports the engine, so
 * putting it there would close an import cycle.
 *
 * Only the *full* fetch reports here. A delta sync carries a handful of
 * messages and is over before anything could usefully be drawn.
 */
export interface FullSyncProgress {
  /** Headers stored so far. */
  done: number
  /** What the server says it holds, or null when it would not say. */
  total: number | null
}

const progress = new Map<string, FullSyncProgress>()
const listeners = new Set<() => void>()

/**
 * Snapshots are replaced, never mutated, and absence is `null` rather than a
 * fresh object — `useSyncExternalStore` compares by identity and would spin
 * forever on a new object per read.
 */
export function setFullSyncProgress(accountId: string, value: FullSyncProgress | null): void {
  const prev = progress.get(accountId) ?? null
  if (prev === null && value === null) return
  if (prev && value && prev.done === value.done && prev.total === value.total) return
  if (value === null) progress.delete(accountId)
  else progress.set(accountId, value)
  for (const fn of listeners) fn()
}

export function getFullSyncProgress(accountId: string): FullSyncProgress | null {
  return progress.get(accountId) ?? null
}

export function subscribeFullSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
