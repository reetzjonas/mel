import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { cancel, discardAction, enqueue, flush, retryAction } from './outbox'

// jsdom has no Web Locks; the outbox takes one around every flush.
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: { request: (_name: string, fn: () => unknown) => Promise.resolve(fn()) },
})

const ACC = 'acc-1'
const executed: string[] = []

type SetOutcome = { updated: string[]; destroyed: string[]; failed: Record<string, unknown> }
type SetEmails = (updates: Record<string, unknown>, destroy: string[]) => Promise<SetOutcome>

/** Records the call and succeeds; tests that need a refusal replace it. */
const recordAndSucceed: SetEmails = (updates) => {
  executed.push(`setEmails:${Object.keys(updates).join(',')}`)
  return Promise.resolve({ updated: Object.keys(updates), destroyed: [], failed: {} })
}
let setEmailsImpl: SetEmails = recordAndSucceed

vi.mock('./connections', () => ({
  connectionFor: () =>
    Promise.resolve({
      mail: {
        setEmails: (updates: Record<string, unknown>, destroy: string[]) =>
          setEmailsImpl(updates, destroy),
      },
    }),
}))
vi.mock('./engine', () => ({ syncAccount: () => Promise.resolve() }))

/** An action left behind by a run that died mid-flight. */
async function stranded(kind: string) {
  await db.outbox.clear()
  await db.outbox.add({
    accountId: ACC,
    kind,
    status: 'inflight',
    attempts: 0,
    notBefore: 0,
    payload: sealPlain({
      kind,
      updates: { 'mail-1': { mailboxIds: { inbox: true } } },
      ids: ['x'],
    }),
  })
}

beforeEach(() => {
  setEmailsImpl = recordAndSucceed
})

describe('outbox recovery after an interrupted run', () => {
  beforeEach(() => {
    executed.length = 0
    vi.restoreAllMocks()
  })

  it('replays an action stranded in flight', async () => {
    // Without recovery this row is invisible forever: flush only picks up
    // `pending`, so it never runs, never fails, and the optimistic local
    // change is silently undone by the next sync.
    await stranded('email.update')

    await flush(ACC)

    expect(executed).toEqual(['setEmails:mail-1'])
    expect(await db.outbox.count()).toBe(0)
  })

  it('refuses to replay something that could duplicate, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await stranded('email.send')

    await flush(ACC)

    // Sending twice is worse than not sending; failing it loudly beats both.
    expect(executed).toEqual([])
    expect((await db.outbox.toArray())[0]?.status).toBe('failed')
    expect(warn.mock.calls.flat().join(' ')).toContain('email.send')
  })

  it('leaves a normal pending action alone', async () => {
    await db.outbox.clear()
    await db.outbox.add({
      accountId: ACC,
      kind: 'email.update',
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain({ kind: 'email.update', updates: { 'mail-2': {} } }),
    })

    await flush(ACC)

    expect(executed).toEqual(['setEmails:mail-2'])
  })
})

describe('managing the queue by hand', () => {
  /*
   * retryAction schedules a real flush behind a setTimeout, and the queue,
   * the fake IndexedDB and `executed` are all shared across these tests. A
   * timer left over from one test firing inside the next one is not
   * hypothetical: it took the `flushing` guard, so the flush the next test
   * awaited returned without doing anything and `executed` stayed empty.
   *
   * Only setTimeout is faked — fake-indexeddb drives its requests off other
   * timing primitives, and faking those wholesale deadlocks every DB await.
   */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    executed.length = 0
  })
  afterEach(() => vi.useRealTimers())

  /** A row that was given up on, as flush leaves it. */
  async function failed(): Promise<number> {
    await db.outbox.clear()
    return db.outbox.add({
      accountId: ACC,
      kind: 'email.update',
      status: 'failed',
      attempts: 3,
      notBefore: Date.now() + 60_000,
      reason: 'forbidden',
      failedAt: Date.now(),
      payload: sealPlain({ kind: 'email.update', updates: { 'mail-3': {} } }),
    })
  }

  it('requeues a failed action without its backoff or its old reason', async () => {
    // A retry is a person saying the obstacle is gone; making them wait out
    // the backoff of the attempt that failed would be answering a different
    // question.
    const seq = await failed()

    await retryAction(seq)

    const row = await db.outbox.get(seq)
    expect(row?.status).toBe('pending')
    expect(row?.attempts).toBe(0)
    expect(row?.notBefore).toBe(0)
    expect(row?.reason).toBeUndefined()
  })

  it('runs the requeued action on the next flush', async () => {
    const seq = await failed()

    await retryAction(seq)
    await flush(ACC)

    expect(executed).toEqual(['setEmails:mail-3'])
    expect(await db.outbox.count()).toBe(0)
  })

  it('discards an action so it is never sent', async () => {
    const seq = await failed()

    await discardAction(seq)

    expect(await db.outbox.get(seq)).toBeUndefined()
  })

  it('refuses to touch an action that is being sent right now', async () => {
    // The flush owns that row: retrying it would run it twice, and deleting it
    // would lose the outcome of a call already on its way.
    //
    // Its own account: `retryAction` above schedules a flush, and a flush that
    // reached this row would recover it as stranded (which is what it is meant
    // to do for a *dead* run) and complete it out from under the assertions.
    await db.outbox.clear()
    const seq = await db.outbox.add({
      accountId: 'acc-inflight',
      kind: 'email.update',
      status: 'inflight',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain({ kind: 'email.update', updates: { 'mail-4': {} } }),
    })

    await retryAction(seq)
    expect((await db.outbox.get(seq))?.status).toBe('inflight')

    await discardAction(seq)
    expect(await db.outbox.get(seq)).toBeDefined()
  })
})

/*
 * What the queue does when the server says no. Both halves matter: a failure
 * that may pass has to come back later without losing its place, and one that
 * never will has to stop being retried and be made visible — the optimistic
 * local change has already happened, so a silently dropped action is a change
 * the next sync quietly undoes.
 */
describe('failing actions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    executed.length = 0
  })
  afterEach(() => vi.useRealTimers())

  /** Two queued updates; the first one fails the way the test asks. */
  async function twoPending(failWith: unknown) {
    await db.outbox.clear()
    for (const id of ['mail-a', 'mail-b']) {
      await db.outbox.add({
        accountId: ACC,
        kind: 'email.update',
        status: 'pending',
        attempts: 0,
        notBefore: 0,
        payload: sealPlain({ kind: 'email.update', updates: { [id]: {} } }),
      })
    }
    setEmailsImpl = (updates) => {
      if (Object.keys(updates)[0] === 'mail-a') throw failWith
      executed.push(`setEmails:${Object.keys(updates).join(',')}`)
      return Promise.resolve({ updated: Object.keys(updates), destroyed: [], failed: {} })
    }
  }

  it('holds the queue behind an action that may still succeed', async () => {
    // Order is the promise the queue makes: running later actions past a
    // stuck one can apply them out of sequence against the server.
    await twoPending(Object.assign(new Error('offline'), { reason: 'network' }))

    await flush(ACC)

    expect(executed).toEqual([])
    const rows = await db.outbox.orderBy('seq').toArray()
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, reason: 'network' })
    // Recorded while it is still retrying, since an action that keeps backing
    // off is the other way to be stuck and nothing else explains it.
    expect(rows[0]!.notBefore).toBeGreaterThan(Date.now())
    expect(rows[1]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('backs off further with each attempt, up to a ceiling', async () => {
    await twoPending(Object.assign(new Error('offline'), { reason: 'network' }))

    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      await flush(ACC)
      const row = (await db.outbox.orderBy('seq').first())!
      waits.push(row.notBefore - Date.now())
      // Let the next flush consider it again without waiting out the backoff.
      await db.outbox.update(row.seq!, { notBefore: 0 })
    }

    expect(waits[1]).toBeGreaterThan(waits[0]!)
    expect(Math.max(...waits)).toBeLessThanOrEqual(5 * 60_000)
  })

  it('gives up loudly on a refusal that will not change, and moves on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await twoPending(
      Object.assign(new Error('forbidden'), { permanent: true, reason: 'forbidden' }),
    )

    await flush(ACC)

    const rows = await db.outbox.orderBy('seq').toArray()
    expect(rows[0]).toMatchObject({ status: 'failed', reason: 'forbidden' })
    expect(warn.mock.calls.flat().join(' ')).toContain('email.update')
    // Only the hopeless one stops; the queue behind it is not held hostage.
    expect(executed).toEqual(['setEmails:mail-b'])
  })
})

describe('a partially rejected set', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    executed.length = 0
  })
  afterEach(() => vi.useRealTimers())

  async function oneUpdate(failed: Record<string, { type: string; permanent: boolean }>) {
    await db.outbox.clear()
    await db.outbox.add({
      accountId: ACC,
      kind: 'email.update',
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain({ kind: 'email.update', updates: { 'mail-1': {} } }),
    })
    setEmailsImpl = () => Promise.resolve({ updated: [], destroyed: [], failed })
  }

  it('treats a rejection the server will repeat as permanent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await oneUpdate({ 'mail-1': { type: 'forbidden', permanent: true } })

    await flush(ACC)

    // The set-error type doubles as the reason: it is already a token, and
    // the column holds no free text.
    expect((await db.outbox.toArray())[0]).toMatchObject({
      status: 'failed',
      reason: 'forbidden',
    })
  })

  it('retries when any part of it might pass next time', async () => {
    await oneUpdate({ 'mail-1': { type: 'serverFail', permanent: false } })

    await flush(ACC)

    expect((await db.outbox.toArray())[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('counts a set with nothing rejected as done', async () => {
    await oneUpdate({})

    await flush(ACC)

    expect(await db.outbox.count()).toBe(0)
  })
})

describe('cancelling a queued action', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => vi.useRealTimers())

  it('takes back an action that has not gone out yet', async () => {
    // This is undo-send: the message waits out its delay as a queued action.
    await db.outbox.clear()
    const seq = await enqueue(
      ACC,
      { kind: 'email.update', updates: { 'mail-1': {} } },
      {
        delayMs: 10_000,
      },
    )

    await expect(cancel(seq)).resolves.toBe(true)
    expect(await db.outbox.count()).toBe(0)
  })

  it('refuses once the action is already in flight', async () => {
    // Cancelling then would leave the server having done it and us pretending
    // otherwise.
    await db.outbox.clear()
    const seq = await db.outbox.add({
      accountId: ACC,
      kind: 'email.send',
      status: 'inflight',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain({ kind: 'email.update', updates: {} }),
    })

    await expect(cancel(seq)).resolves.toBe(false)
    expect(await db.outbox.count()).toBe(1)
  })

  it('is false for an action that is not there at all', async () => {
    await db.outbox.clear()
    await expect(cancel(9999)).resolves.toBe(false)
  })
})
