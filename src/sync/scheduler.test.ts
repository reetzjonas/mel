import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import {
  getSyncStatus,
  inboxUnreadSince,
  startScheduler,
  stopScheduler,
  subscribeSyncStatus,
} from './scheduler'

/*
 * The sync bar reads all of this, and it is the only evidence anyone has that
 * mail is still arriving — so "quiet mailbox" and "cannot reach the server"
 * must never look the same.
 *
 * Driven through startScheduler rather than a hook added for the test: the
 * tick is internal on purpose, and an export made for convenience here would
 * be a seam the app itself never uses. The SSE side is driven through the
 * handlers the scheduler hands the library, which is the same surface a real
 * connection delivers on; whether the connection itself holds up is left to
 * the e2e suite.
 */
const syncAccount = vi.fn(async (_id: string) => {})
const flush = vi.fn(async (_id: string) => {})
const notifyNewMail = vi.fn(async (_id: string) => {})

vi.mock('./engine', () => ({ syncAccount: (id: string) => syncAccount(id) }))
vi.mock('./outbox', () => ({ flush: (id: string) => flush(id) }))
vi.mock('../services/notifications', () => ({ notifyNewMail: (id: string) => notifyNewMail(id) }))
/**
 * What connectionFor answers with. Null push makes startSse fall through to
 * polling, whose timer stopScheduler clears — the default for the tests that
 * are not about the push pipe.
 */
let push: unknown = null
let connectionFails: Error | null = null
vi.mock('./connections', () => ({
  connectionFor: () =>
    connectionFails ? Promise.reject(connectionFails) : Promise.resolve({ push }),
}))

/** The SSE handlers the scheduler installed, so a test can drive them. */
let sse: {
  url: string
  onopen?: (res: { ok: boolean; status: number }) => Promise<void>
  onmessage?: (ev: { event: string; data: string }) => void
  onerror?: (e: unknown) => void
} | null = null
/** Ends the fetchEventSource call, the way a dropped connection would. */
let endSse: (e?: Error) => void = () => {}
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: (url: string, opts: Record<string, unknown>) => {
    sse = { url, ...(opts as object) } as typeof sse
    return new Promise<void>((resolve, reject) => {
      endSse = (e) => (e ? reject(e) : resolve())
    })
  },
}))

const ACC = 'acc-1'

/** Start the scheduler and wait out the tick it fires immediately. */
async function firstTick() {
  startScheduler(ACC)
  await vi.waitFor(() => expect(getSyncStatus(ACC).syncing).toBe(false))
}

describe('the status the sync bar renders', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => stopScheduler(ACC))

  it('is idle for an account nothing has started for', () => {
    expect(getSyncStatus('never-started')).toMatchObject({
      mode: 'stopped',
      syncing: false,
      error: null,
      lastSyncAt: 0,
    })
  })

  it('hands out the same snapshot until something changes', () => {
    // useSyncExternalStore compares by identity: a fresh object per read
    // would re-render the sidebar for ever.
    expect(getSyncStatus('never-started')).toBe(getSyncStatus('never-started'))
  })

  it('publishes both edges of a tick, so a spinner can start and stop', async () => {
    const seen: boolean[] = []
    const stop = subscribeSyncStatus(() => seen.push(getSyncStatus(ACC).syncing))

    await firstTick()
    stop()

    expect(seen).toContain(true)
    expect(seen.at(-1)).toBe(false)
    expect(getSyncStatus(ACC).lastSyncAt).toBeGreaterThan(0)
    expect(getSyncStatus(ACC).error).toBeNull()
  })

  it('sends what is queued before fetching what is new', async () => {
    // The other order pulls the server's version over an edit that has not
    // gone out yet, and the edit loses without a word.
    const order: string[] = []
    flush.mockImplementationOnce(async () => void order.push('flush'))
    syncAccount.mockImplementationOnce(async () => void order.push('sync'))

    await firstTick()

    expect(order).toEqual(['flush', 'sync'])
  })

  it('records a failure instead of leaving the bar looking quiet', async () => {
    syncAccount.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await firstTick()

    expect(getSyncStatus(ACC).error).not.toBeNull()
    // And it stops claiming to be busy even though the tick threw.
    expect(getSyncStatus(ACC).syncing).toBe(false)
    // A failed tick is not a sync: saying "synced just now" would be a lie.
    expect(getSyncStatus(ACC).lastSyncAt).toBe(0)
  })

  it('forgets the account when its scheduler stops', async () => {
    // Sign-out purges the account; a status left behind would go on naming it.
    await firstTick()
    expect(getSyncStatus(ACC).lastSyncAt).toBeGreaterThan(0)

    await stopScheduler(ACC)

    expect(getSyncStatus(ACC)).toMatchObject({ mode: 'stopped', lastSyncAt: 0 })
  })

  it('starts once, however often it is asked', async () => {
    // The mail route starts it on every mount; a second scheduler would mean
    // two pollers and two of every request.
    await firstTick()
    const ticks = syncAccount.mock.calls.length
    startScheduler(ACC)
    await vi.waitFor(() => expect(getSyncStatus(ACC).syncing).toBe(false))

    expect(syncAccount.mock.calls.length).toBe(ticks)
  })
})

describe('live updates over the push pipe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sse = null
    connectionFails = null
    push = {
      eventSourceUrl: 'https://jmap.test/events?types={types}&closeafter={closeafter}&ping={ping}',
      credentials: { method: 'basic', username: 'alice', secret: 'pw' },
    }
  })
  afterEach(async () => {
    await stopScheduler(ACC)
    push = null
    endSse()
  })

  /** Start and wait until the scheduler has opened the event stream. */
  async function connected() {
    startScheduler(ACC)
    await vi.waitFor(() => expect(sse).not.toBeNull())
    await sse!.onopen!({ ok: true, status: 200 })
  }

  it('asks for every type, a connection that stays open, and a keepalive', async () => {
    /*
     * The URL is a template the server hands out. Leaving {closeafter} unfilled
     * gives a stream that ends after one event, and without a ping an idle
     * connection is dropped by proxies with nothing to notice it.
     */
    await connected()

    expect(sse!.url).toBe('https://jmap.test/events?types=*&closeafter=no&ping=30')
    expect(getSyncStatus(ACC).mode).toBe('push')
    expect(getSyncStatus(ACC).intervalMs).toBe(0)
  })

  it('syncs when the server says something changed', async () => {
    await connected()
    const before = syncAccount.mock.calls.length

    sse!.onmessage!({ event: 'state', data: JSON.stringify({ changed: { a1: { Email: 's2' } } }) })

    await vi.waitFor(() => expect(syncAccount.mock.calls.length).toBeGreaterThan(before))
  })

  it('ignores the keepalives and anything it cannot read', async () => {
    /*
     * Pings arrive every thirty seconds and carry no state. Syncing on those,
     * or throwing on a malformed payload out of the stream, would turn push
     * into a poll — or end the connection outright.
     */
    await connected()
    const before = syncAccount.mock.calls.length

    sse!.onmessage!({ event: 'ping', data: '{}' })
    sse!.onmessage!({ event: 'state', data: '' })
    sse!.onmessage!({ event: 'state', data: 'not json' })
    sse!.onmessage!({ event: 'state', data: JSON.stringify({ changed: null }) })

    await Promise.resolve()
    expect(syncAccount.mock.calls.length).toBe(before)
  })

  it('treats a refused stream as a failure rather than an open one', async () => {
    // A 401 answers the request but not with a stream; reporting "push" there
    // leaves the bar claiming live updates that never arrive.
    startScheduler(ACC)
    await vi.waitFor(() => expect(sse).not.toBeNull())

    await expect(sse!.onopen!({ ok: false, status: 401 })).rejects.toThrow('401')
  })

  it('rides out a couple of drops before giving up on push', async () => {
    /*
     * A reconnect is normal — a laptop lid, a proxy timeout. Falling back to
     * polling on the first one would abandon push for the whole session.
     */
    await connected()

    expect(() => sse!.onerror!(new Error('dropped'))).not.toThrow()
    expect(() => sse!.onerror!(new Error('dropped'))).not.toThrow()
    // The third is the library's cue to stop retrying.
    expect(() => sse!.onerror!(new Error('dropped'))).toThrow('dropped')
  })

  it('falls back to polling when the stream finally fails', async () => {
    await connected()
    endSse(new Error('gone'))

    await vi.waitFor(() => expect(getSyncStatus(ACC).mode).toBe('poll'))
    expect(getSyncStatus(ACC).intervalMs).toBeGreaterThan(0)
  })

  it('polls when the server offers no push at all', async () => {
    push = null

    startScheduler(ACC)

    await vi.waitFor(() => expect(getSyncStatus(ACC).mode).toBe('poll'))
  })

  it('says why rather than sitting on "connecting" when the session cannot be fetched', async () => {
    /*
     * Opening the connection fetches the session document, which is exactly
     * where a missing CORS header bites. That rejection used to go nowhere and
     * the bar stayed on "connecting" for ever.
     */
    connectionFails = new TypeError('Failed to fetch')

    startScheduler(ACC)

    // Polling, not "connecting" for ever. The reason reaches the bar through
    // the tick, which fails against the same server for the same cause.
    await vi.waitFor(() => expect(getSyncStatus(ACC).mode).toBe('poll'))
  })
})

describe('a server that asks us to slow down', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sse = null
    connectionFails = null
    push = null
  })
  afterEach(() => stopScheduler(ACC))

  it('comes back when the server said to, not a poll interval later', async () => {
    /*
     * A 429 carries Retry-After, and it is usually far shorter than the poll
     * interval. Waiting out the full thirty seconds leaves the list empty for
     * half a minute because the server asked for two — which is how a
     * rate-limited first sync looks like a broken one.
     */
    syncAccount.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 429'), { kind: 'ratelimit', retryAfterMs: 2_000 }),
    )

    await firstTick()

    await vi.waitFor(() => expect(getSyncStatus(ACC).mode).toBe('poll'))
    expect(getSyncStatus(ACC).intervalMs).toBe(2_000)
  })

  it('goes back to the ordinary interval once a tick gets through', async () => {
    /*
     * The wait belongs to the refusal, not to the session. Keeping it would
     * let one 429 set the polling rate for good; dropping it after a single
     * poll would stop obeying a server that is still saying no.
     */
    syncAccount.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 429'), { kind: 'ratelimit', retryAfterMs: 2_000 }),
    )

    await firstTick()
    await vi.waitFor(() => expect(getSyncStatus(ACC).intervalMs).toBe(2_000))

    // That poll fires two seconds later and succeeds (the mock rejected only
    // once), which is what clears the wait.
    await vi.waitFor(() => expect(getSyncStatus(ACC).error).toBeNull(), { timeout: 5_000 })
    await vi.waitFor(() => expect(getSyncStatus(ACC).intervalMs).toBe(30_000), { timeout: 5_000 })
  })

  it('never polls faster than a second, whatever it is told', async () => {
    // A misconfigured or hostile Retry-After of zero would turn the backoff
    // into a tight loop against a server that has just asked for less traffic.
    syncAccount.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 429'), { kind: 'ratelimit', retryAfterMs: 0 }),
    )

    await firstTick()

    await vi.waitFor(() => expect(getSyncStatus(ACC).mode).toBe('poll'))
    expect(getSyncStatus(ACC).intervalMs).toBe(1_000)
  })
})

describe('waiting for a tick to finish', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => stopScheduler(ACC))

  it('stops only once the tick in flight is done', async () => {
    /*
     * Sign-out leans on this: a tick already running holds a connection and
     * happily writes rows after the purge, so the wipe waits for it. Before
     * that wait existed, signing out mid-sync left the previous user's mail
     * on the device.
     */
    let finish!: () => void
    syncAccount.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))

    startScheduler(ACC)
    await vi.waitFor(() => expect(syncAccount).toHaveBeenCalled())

    let stopped = false
    const stopping = stopScheduler(ACC).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    finish()
    await stopping
    expect(stopped).toBe(true)
  })
})

describe('what notifications are allowed to announce', () => {
  const put = (id: string, receivedAt: number, unread: 0 | 1) =>
    db.emails.put({
      accountId: ACC,
      id,
      threadId: `t-${id}`,
      receivedAt,
      mailboxIds: ['inbox'],
      mailboxDates: [],
      unread,
      flagged: 0,
      payload: sealPlain({ id, subject: id } as never),
    })

  beforeEach(() => db.emails.clear())

  it('is only what arrived after the last check, and only what is unread', async () => {
    /*
     * Both halves matter. Without the cutoff, every message in the mailbox is
     * announced on the first sync after a reload; without the unread filter,
     * a message read on the phone is announced again here.
     */
    await put('old', 1_000, 1)
    await put('new', 3_000, 1)
    await put('read-elsewhere', 4_000, 0)

    const fresh = await inboxUnreadSince(ACC, 2_000)

    expect(fresh.map((m) => m.id)).toEqual(['new'])
  })

  it('never reaches into another account on the same device', async () => {
    await put('mine', 3_000, 1)
    await db.emails.put({
      accountId: 'other',
      id: 'theirs',
      threadId: 't',
      receivedAt: 3_000,
      mailboxIds: ['inbox'],
      mailboxDates: [],
      unread: 1,
      flagged: 0,
      payload: sealPlain({ id: 'theirs' } as never),
    })

    const fresh = await inboxUnreadSince(ACC, 0)

    expect(fresh.map((m) => m.id)).toEqual(['mine'])
  })
})
