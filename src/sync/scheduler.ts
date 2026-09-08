import { fetchEventSource } from '@microsoft/fetch-event-source'
import { authHeader } from '../providers/jmap/client/transport'
import type { StateChange } from '../providers/jmap/client/types/core'
import { classifyConnectionError, type ConnectionError } from '../lib/netError'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'
import { notifyNewMail } from '../services/notifications'
import { connectionFor } from './connections'
import { syncAccount } from './engine'
import { flush } from './outbox'

const POLL_FOREGROUND_MS = 30_000
const POLL_HIDDEN_MS = 5 * 60_000
const SSE_MAX_FAILURES = 3

interface Controller {
  abort: AbortController
  pollTimer: ReturnType<typeof setTimeout> | null
  sseFailures: number
  stopped: boolean
}

const controllers = new Map<string, Controller>()

/** How updates are reaching us right now, as opposed to what the server offers. */
export type SyncMode = 'connecting' | 'push' | 'poll' | 'stopped'

export interface SyncStatus {
  mode: SyncMode
  /** Poll interval in ms; 0 while pushing. */
  intervalMs: number
  /** Epoch ms of the last tick that completed without throwing; 0 if none yet. */
  lastSyncAt: number
  syncing: boolean
  /** Last failure, cleared by the next successful tick. */
  error: ConnectionError | null
}

const IDLE: SyncStatus = {
  mode: 'stopped',
  intervalMs: 0,
  lastSyncAt: 0,
  syncing: false,
  error: null,
}

const statuses = new Map<string, SyncStatus>()
const listeners = new Set<() => void>()

/**
 * Snapshots are replaced, never mutated: useSyncExternalStore compares by
 * identity and would miss an in-place edit.
 */
function setStatus(accountId: string, patch: Partial<SyncStatus>) {
  const prev = statuses.get(accountId) ?? IDLE
  const next = { ...prev, ...patch }
  if (
    next.mode === prev.mode &&
    next.intervalMs === prev.intervalMs &&
    next.lastSyncAt === prev.lastSyncAt &&
    next.syncing === prev.syncing &&
    next.error?.kind === prev.error?.kind &&
    next.error?.detail === prev.error?.detail
  )
    return
  statuses.set(accountId, next)
  for (const fn of listeners) fn()
}

export function getSyncStatus(accountId: string): SyncStatus {
  return statuses.get(accountId) ?? IDLE
}

export function subscribeSyncStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function tick(accountId: string) {
  setStatus(accountId, { syncing: true })
  try {
    await flush(accountId)
    await syncAccount(accountId)
    await notifyNewMail(accountId)
    setStatus(accountId, { lastSyncAt: Date.now(), error: null })
  } catch (e) {
    // The next tick retries, but the failure must not stay invisible: a server
    // that rejects us on CORS otherwise looks exactly like a quiet mailbox.
    setStatus(accountId, { error: classifyConnectionError(e) })
  } finally {
    setStatus(accountId, { syncing: false })
  }
}

function schedulePoll(accountId: string, ctl: Controller) {
  if (ctl.stopped) return
  if (ctl.pollTimer) clearTimeout(ctl.pollTimer)
  const interval = document.hidden ? POLL_HIDDEN_MS : POLL_FOREGROUND_MS
  setStatus(accountId, { mode: 'poll', intervalMs: interval })
  ctl.pollTimer = setTimeout(() => {
    void tick(accountId).finally(() => schedulePoll(accountId, ctl))
  }, interval)
}

async function startSse(accountId: string, ctl: Controller) {
  let conn
  try {
    conn = await connectionFor(accountId)
  } catch (e) {
    // Opening the connection means fetching the session document, and that is
    // exactly where a missing CORS header bites. Without this catch the
    // rejection went nowhere and the UI sat on "connecting" indefinitely.
    setStatus(accountId, { error: classifyConnectionError(e) })
    schedulePoll(accountId, ctl)
    return
  }
  if (!conn.push) {
    schedulePoll(accountId, ctl)
    return
  }
  const url = conn.push.eventSourceUrl
    .replace('{types}', '*')
    .replace('{closeafter}', 'no')
    .replace('{ping}', '30')

  try {
    await fetchEventSource(url, {
      signal: ctl.abort.signal,
      headers: { Authorization: authHeader(conn.push.credentials) },
      openWhenHidden: true,
      onopen: async (res) => {
        if (!res.ok) throw new Error(`SSE ${res.status}`)
        ctl.sseFailures = 0
        setStatus(accountId, { mode: 'push', intervalMs: 0 })
      },
      onmessage: (ev) => {
        if (ev.event !== 'state' || !ev.data) return
        try {
          const change = JSON.parse(ev.data) as StateChange
          if (change.changed) void tick(accountId)
        } catch {
          /* malformed event */
        }
      },
      onerror: (err) => {
        ctl.sseFailures++
        if (ctl.sseFailures >= SSE_MAX_FAILURES) {
          throw err instanceof Error ? err : new Error('SSE failed')
        }
        // returning undefined lets fetch-event-source retry with backoff
      },
    })
  } catch {
    if (!ctl.stopped) schedulePoll(accountId, ctl)
  }
}

/** Start live updates for an account: SSE when available, polling fallback. */
export function startScheduler(accountId: string) {
  if (controllers.has(accountId)) return
  const ctl: Controller = {
    abort: new AbortController(),
    pollTimer: null,
    sseFailures: 0,
    stopped: false,
  }
  controllers.set(accountId, ctl)
  setStatus(accountId, { mode: 'connecting', intervalMs: 0 })
  void tick(accountId)
  void startSse(accountId, ctl)

  const onVisibility = () => {
    if (!document.hidden) void tick(accountId)
  }
  const onOnline = () => void tick(accountId)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
}

export function stopScheduler(accountId: string) {
  const ctl = controllers.get(accountId)
  if (!ctl) return
  ctl.stopped = true
  ctl.abort.abort()
  if (ctl.pollTimer) clearTimeout(ctl.pollTimer)
  controllers.delete(accountId)
  statuses.delete(accountId)
  for (const fn of listeners) fn()
}

/** Newest inbox arrivals, used by notifications to diff. */
export async function inboxUnreadSince(accountId: string, sinceMs: number) {
  const rows = await db.emails
    .where('[accountId+receivedAt]')
    .between([accountId, sinceMs], [accountId, Infinity])
    .toArray()
  return rows.filter((r) => r.unread === 1).map((r) => openEnvelope(r.payload))
}
