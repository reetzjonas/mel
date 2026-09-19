import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventNotification } from '../domain/calendar'
import type { SetFailure } from '../providers/types'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'

let failure: SetFailure | null = null
let hasProvider = true
let throws = false
const dismissed: string[][] = []

vi.mock('../sync/connections', () => ({
  connectionFor: () =>
    Promise.resolve({
      calendars: hasProvider
        ? {
            dismissEventNotifications: (ids: string[]) => {
              if (throws) return Promise.reject(new Error('offline'))
              dismissed.push(ids)
              return Promise.resolve(failure)
            },
          }
        : null,
    }),
}))

const { dismissNotifications } = await import('./eventNotifications')

const note = (id: string): EventNotification => ({
  id,
  created: '2026-09-19T10:00:00Z',
  kind: 'accepted',
  by: 'Bob',
  byEmail: 'bob@x',
  eventId: 'e1',
  title: 'T',
  comment: '',
})

const ids = async () => (await db.eventNotifications.toArray()).map((r) => r.id).sort()

beforeEach(async () => {
  failure = null
  hasProvider = true
  throws = false
  dismissed.length = 0
  await db.eventNotifications.clear()
  await db.eventNotifications.bulkPut(
    ['a', 'b', 'c'].map((id) => ({ accountId: 'acc', id, payload: sealPlain(note(id)) })),
  )
})

describe('dismissNotifications', () => {
  it('removes them on the server and then here', async () => {
    expect(await dismissNotifications('acc', ['a', 'b'])).toBeNull()
    expect(dismissed).toEqual([['a', 'b']])
    expect(await ids()).toEqual(['c'])
  })

  it('keeps them here when the server refuses, so the click is not silently undone', async () => {
    failure = { type: 'forbidden', description: 'No', permanent: true }
    expect(await dismissNotifications('acc', ['a'])).toBe('No')
    expect(await ids()).toEqual(['a', 'b', 'c'])
  })

  it('keeps them here when the server cannot be reached', async () => {
    throws = true
    expect(await dismissNotifications('acc', ['a'])).toBe('offline')
    expect(await ids()).toEqual(['a', 'b', 'c'])
  })

  it('does nothing for an empty list', async () => {
    expect(await dismissNotifications('acc', [])).toBeNull()
    expect(dismissed).toEqual([])
  })

  it('reports an account without calendars', async () => {
    hasProvider = false
    expect(await dismissNotifications('acc', ['a'])).toBe('noProvider')
    expect(await ids()).toEqual(['a', 'b', 'c'])
  })

  it("only touches this account's rows", async () => {
    await db.eventNotifications.put({ accountId: 'other', id: 'a', payload: sealPlain(note('a')) })
    await dismissNotifications('acc', ['a'])
    expect(
      (await db.eventNotifications.toArray()).map((r) => `${r.accountId}/${r.id}`).sort(),
    ).toEqual(['acc/b', 'acc/c', 'other/a'])
  })
})
