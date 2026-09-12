import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSyncStatus, startScheduler, stopScheduler, subscribeSyncStatus } from './scheduler'

/*
 * The sync bar reads all of this, and it is the only evidence anyone has that
 * mail is still arriving — so "quiet mailbox" and "cannot reach the server"
 * must never look the same.
 *
 * Driven through startScheduler rather than a hook added for the test: the
 * tick is internal on purpose, and an export made for convenience here would
 * be a seam the app itself never uses. The SSE and polling machinery is left
 * to the e2e suite, which can watch a real connection.
 */
const syncAccount = vi.fn(async (_id: string) => {})
const flush = vi.fn(async (_id: string) => {})
const notifyNewMail = vi.fn(async (_id: string) => {})

vi.mock('./engine', () => ({ syncAccount: (id: string) => syncAccount(id) }))
vi.mock('./outbox', () => ({ flush: (id: string) => flush(id) }))
vi.mock('../services/notifications', () => ({ notifyNewMail: (id: string) => notifyNewMail(id) }))
// No push: startSse falls through to polling, whose timer stopScheduler clears.
vi.mock('./connections', () => ({ connectionFor: () => Promise.resolve({ push: null }) }))

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
