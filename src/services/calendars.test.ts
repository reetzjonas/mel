import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEdit, SetFailure } from '../providers/types'

const edits: CalendarEdit[] = []
let failWith: SetFailure | null = null
let hasProvider = true
const syncAccount = vi.fn(async () => {})

vi.mock('../sync/connections', () => ({
  connectionFor: () =>
    Promise.resolve({
      calendars: hasProvider
        ? {
            editCalendar: (edit: CalendarEdit) => {
              edits.push(edit)
              return Promise.resolve({ id: 'new', failure: failWith })
            },
          }
        : null,
    }),
}))
vi.mock('../sync/engine', () => ({ syncAccount: () => syncAccount() }))

const { createCalendar, deleteCalendar, updateCalendar } = await import('./calendars')

beforeEach(() => {
  edits.length = 0
  failWith = null
  hasProvider = true
  syncAccount.mockClear()
})

describe('createCalendar', () => {
  it('creates and then brings the local copy up to date', async () => {
    expect(await createCalendar('acc', 'Work', '#2d5bd1')).toBeNull()
    expect(edits).toEqual([{ create: { name: 'Work', color: '#2d5bd1' } }])
    expect(syncAccount).toHaveBeenCalledTimes(1)
  })

  it("passes on the server's reason for refusing", async () => {
    failWith = { type: 'forbidden', description: 'Not allowed', permanent: true }
    expect(await createCalendar('acc', 'Work', null)).toBe('Not allowed')
  })

  it('falls back to the error type when the server gave no description', async () => {
    failWith = { type: 'overQuota', permanent: true }
    expect(await createCalendar('acc', 'Work', null)).toBe('overQuota')
  })

  it('says so when the account has no calendars at all', async () => {
    hasProvider = false
    expect(await createCalendar('acc', 'Work', null)).toBe('noProvider')
    expect(edits).toEqual([])
  })
})

describe('updateCalendar', () => {
  it('sends only what changed', async () => {
    await updateCalendar('acc', 'c1', { name: 'Home' })
    expect(edits).toEqual([{ update: { id: 'c1', name: 'Home' } }])
  })

  it('can remove a colour', async () => {
    await updateCalendar('acc', 'c1', { color: null })
    expect(edits[0]).toEqual({ update: { id: 'c1', color: null } })
  })
})

describe('deleteCalendar', () => {
  it('does not take the events along unless asked', async () => {
    const r = await deleteCalendar('acc', 'c1')
    expect(r).toEqual({ ok: true })
    expect(edits).toEqual([{ destroy: 'c1', destroyWithEvents: false }])
  })

  it('takes them along when asked', async () => {
    await deleteCalendar('acc', 'c1', { withEvents: true })
    expect(edits[0]).toEqual({ destroy: 'c1', destroyWithEvents: true })
  })

  it('tells a calendar that still has events apart from any other refusal', async () => {
    failWith = { type: 'calendarHasEvent', description: 'Calendar is not empty.', permanent: true }
    expect(await deleteCalendar('acc', 'c1')).toEqual({
      ok: false,
      blocker: 'hasEvents',
      message: 'Calendar is not empty.',
    })
    failWith = { type: 'forbidden', permanent: true }
    expect(await deleteCalendar('acc', 'c1')).toMatchObject({ ok: false, blocker: 'other' })
  })

  it('syncs whether or not it worked, so the list shows what the server has', async () => {
    failWith = { type: 'forbidden', permanent: true }
    await deleteCalendar('acc', 'c1')
    expect(syncAccount).toHaveBeenCalledTimes(1)
  })
})
