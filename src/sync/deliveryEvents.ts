import type { Submission } from '../domain/submission'

/**
 * Refusals the sync has just learned about, for whoever wants to say so
 * (issue #70). The sync is in no position to show anything itself, and the
 * page that is does not otherwise hear from it.
 */
type Listener = (accountId: string, submissions: Submission[]) => void

const listeners = new Set<Listener>()

export function onNewDeliveryFailures(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function announceDeliveryFailures(accountId: string, submissions: Submission[]): void {
  if (!submissions.length) return
  for (const fn of listeners) fn(accountId, submissions)
}
