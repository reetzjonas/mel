import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { discardAction, flush, retryAction } from './outbox'

// jsdom has no Web Locks; the outbox takes one around every flush.
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: { request: (_name: string, fn: () => unknown) => Promise.resolve(fn()) },
})

const ACC = 'acc-1'
const executed: string[] = []

vi.mock('./connections', () => ({
  connectionFor: () =>
    Promise.resolve({
      mail: {
        setEmails: (updates: Record<string, unknown>) => {
          executed.push(`setEmails:${Object.keys(updates).join(',')}`)
          return Promise.resolve({ updated: Object.keys(updates), destroyed: [], failed: {} })
        },
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
    executed.length = 0
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
