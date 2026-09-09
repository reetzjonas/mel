import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import { flush } from './outbox'

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
    payload: sealPlain({ kind, updates: { 'mail-1': { mailboxIds: { inbox: true } } }, ids: ['x'] }),
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
