import { fetchEventSource } from '@microsoft/fetch-event-source'
import { authorizedFetch } from '../providers/jmap/client/auth'
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

/**
 * In-flight ticks, so a shutdown can wait for one to finish.
 *
 * syncSettled() only knows about syncAccount(); a tick sitting in flush() before
 * it has even called syncAccount is invisible there, and would go on to write
 * rows after a sign-out had already purged them.
 */
const inflight = new Map<string, Promise<void>>()

function runTick(accountId: string): Promise<void> {
  const p = tick(accountId).finally(() => {
    if (inflight.get(accountId) === p) inflight.delete(accountId)
  })
  inflight.set(accountId, p)
  return p
}

/**
 * What the server asked us to wait before the next attempt, when it said so.
 *
 * A 429 carries Retry-After, and it is usually far shorter than a poll
 * interval — a server throttling us for two seconds should not leave the list
 * empty for thirty, which is how a rate-limited first sync comes to look like
 * a broken one. Held until a tick succeeds rather than consumed by one poll,
 * so a server that keeps refusing keeps being obeyed.
 */
const askedToWait = new Map<string, number>()

/** Never poll faster than this, however eager the server's Retry-After. */
const MIN_RETRY_MS = 1_000

async function tick(accountId: string) {
  setStatus(accountId, { syncing: true })
  try {
    await flush(accountId)
    await syncAccount(accountId)
    await notifyNewMail(accountId)
    askedToWait.delete(accountId)
    setStatus(accountId, { lastSyncAt: Date.now(), error: null })
  } catch (e) {
    const retryAfter = (e as { retryAfterMs?: number } | null)?.retryAfterMs
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      askedToWait.set(accountId, Math.max(MIN_RETRY_MS, retryAfter))
      // Re-arm now rather than leaving it to the poll already scheduled: the
      // first tick runs *before* polling is set up, so the first refusal —
      // the one that matters, at login — would otherwise take a full interval
      // to act on the wait the server just named.
      const ctl = controllers.get(accountId)
      if (ctl) schedulePoll(accountId, ctl)
    }
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
  const interval =
    askedToWait.get(accountId) ?? (document.hidden ? POLL_HIDDEN_MS : POLL_FOREGROUND_MS)
  setStatus(accountId, { mode: 'poll', intervalMs: interval })
  ctl.pollTimer = setTimeout(() => {
    void runTick(accountId).finally(() => schedulePoll(accountId, ctl))
  }, interval)
}

/**
 * One event stream per session, shared by its accounts.
 *
 * The stream is the session's (RFC 8620 S7.3): it reports changes for every
 * account the login reaches, each under its own id, so a second account of a
 * session joins the stream already open rather than opening another, and a
 * change wakes only the accounts it names.
 */
interface Stream {
  abort: AbortController
  /** Local account id → the provider's id for it (unknown: woken by any change). */
  members: Map<string, string | undefined>
  open: boolean
  failures: number
}

const streams = new Map<string, Stream>()
const streamOf = new Map<string, string>()

function leaveStream(accountId: string) {
  const key = streamOf.get(accountId)
  streamOf.delete(accountId)
  const stream = key ? streams.get(key) : undefined
  if (!key || !stream) return
  stream.members.delete(accountId)
  if (stream.members.size) return
  streams.delete(key)
  stream.abort.abort()
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
  if (ctl.stopped) return
  if (!conn.push) {
    schedulePoll(accountId, ctl)
    return
  }
  const key = conn.account?.sessionId ?? accountId
  streamOf.set(accountId, key)
  const joined = streams.get(key)
  if (joined) {
    joined.members.set(accountId, conn.account?.remoteAccountId)
    if (joined.open) {
      setStatus(accountId, { mode: 'push', intervalMs: 0 })
      void runTick(accountId)
    }
    return
  }
  const stream: Stream = {
    abort: new AbortController(),
    members: new Map([[accountId, conn.account?.remoteAccountId]]),
    open: false,
    failures: 0,
  }
  streams.set(key, stream)

  const credentials = conn.push.credentials
  const url = conn.push.eventSourceUrl
    .replace('{types}', '*')
    .replace('{closeafter}', 'no')
    .replace('{ping}', '30')

  try {
    await fetchEventSource(url, {
      signal: stream.abort.signal,
      // Through the session's own fetch rather than a fixed header, so a token
      // that expires is renewed on the reconnect instead of failing it.
      fetch: (input, init) => authorizedFetch(credentials, input, init),
      openWhenHidden: true,
      onopen: async (res) => {
        if (!res.ok) throw new Error(`SSE ${res.status}`)
        stream.failures = 0
        stream.open = true
        /*
         * Catch up once now. The stream announces changes from the moment it
         * is open and polling is off while it is, so anything that changed
         * between the last sync and this moment — the first tick runs while
         * the connection is still being made — would otherwise wait for the
         * next unrelated change. The engine runs it after any pass already
         * going, which has read part of the account before the change. The
         * same goes for a reconnect after the connection dropped.
         */
        for (const id of stream.members.keys()) {
          setStatus(id, { mode: 'push', intervalMs: 0 })
          void runTick(id)
        }
      },
      onmessage: (ev) => {
        if (ev.event !== 'state' || !ev.data) return
        try {
          const change = JSON.parse(ev.data) as StateChange
          if (!change.changed) return
          for (const [id, remote] of stream.members) {
            if (remote === undefined || remote in change.changed) void runTick(id)
          }
        } catch {
          /* malformed event */
        }
      },
      onerror: (err) => {
        stream.failures++
        if (stream.failures >= SSE_MAX_FAILURES) {
          throw err instanceof Error ? err : new Error('SSE failed')
        }
        // returning undefined lets fetch-event-source retry with backoff
      },
    })
  } catch {
    // Given up on: every account it served polls instead.
    stream.open = false
    if (streams.get(key) === stream) streams.delete(key)
    for (const id of stream.members.keys()) {
      streamOf.delete(id)
      const c = controllers.get(id)
      if (c && !c.stopped) schedulePoll(id, c)
    }
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
  void runTick(accountId)
  void startSse(accountId, ctl)

  const onVisibility = () => {
    if (!document.hidden) void runTick(accountId)
  }
  const onOnline = () => void runTick(accountId)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
}

/** Resolves once the scheduler has stopped *and* any running tick has finished. */
export function stopScheduler(accountId: string): Promise<void> {
  const settled = inflight.get(accountId)?.catch(() => {}) ?? Promise.resolve()
  const ctl = controllers.get(accountId)
  if (!ctl) return settled
  ctl.stopped = true
  ctl.abort.abort()
  leaveStream(accountId)
  if (ctl.pollTimer) clearTimeout(ctl.pollTimer)
  controllers.delete(accountId)
  statuses.delete(accountId)
  askedToWait.delete(accountId)
  for (const fn of listeners) fn()
  return settled
}

/** Newest inbox arrivals, used by notifications to diff. */
export async function inboxUnreadSince(accountId: string, sinceMs: number) {
  const rows = await db.emails
    .where('[accountId+receivedAt]')
    .between([accountId, sinceMs], [accountId, Infinity])
    .toArray()
  return rows.filter((r) => r.unread === 1).map((r) => openEnvelope(r.payload))
}
