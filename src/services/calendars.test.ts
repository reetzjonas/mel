import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Calendar } from '../domain/calendar'
import type { CalendarEdit, SetFailure } from '../providers/types'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

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

const calendar = (over: Partial<Calendar> = {}): Calendar => ({
  id: 'c1',
  name: 'Old',
  color: '#111111',
  isDefault: false,
  mayWrite: true,
  mayDelete: true,
  ...over,
})
const stored = async (id: string) => {
  const row = await db.calendars.get(['acc', id])
  return row ? openEnvelope(row.payload) : undefined
}

beforeEach(async () => {
  await db.calendars.clear()
  await db.calendars.put({ accountId: 'acc', id: 'c1', payload: sealPlain(calendar()) })
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

  it('shows the new calendar at once, without waiting for the sync', async () => {
    await createCalendar('acc', 'Work', '#2d5bd1')
    expect(await stored('new')).toMatchObject({ name: 'Work', color: '#2d5bd1', isDefault: false })
  })

  it('stores nothing when the server refuses', async () => {
    failWith = { type: 'forbidden', permanent: true }
    await createCalendar('acc', 'Work', null)
    expect(await stored('new')).toBeUndefined()
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

  it('updates the local copy at once and leaves what did not change alone', async () => {
    await updateCalendar('acc', 'c1', { name: 'Home' })
    expect(await stored('c1')).toMatchObject({ name: 'Home', color: '#111111' })
  })

  it('leaves the local copy alone when the server refuses', async () => {
    failWith = { type: 'forbidden', permanent: true }
    await updateCalendar('acc', 'c1', { name: 'Home' })
    expect((await stored('c1'))!.name).toBe('Old')
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

  it('removes the local copy at once, and keeps it when refused', async () => {
    failWith = { type: 'calendarHasEvent', permanent: true }
    await deleteCalendar('acc', 'c1')
    expect(await stored('c1')).toBeDefined()
    failWith = null
    await deleteCalendar('acc', 'c1')
    expect(await stored('c1')).toBeUndefined()
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

  it('starts a sync whether or not it worked, so the list ends up as the server has it', async () => {
    failWith = { type: 'forbidden', permanent: true }
    await deleteCalendar('acc', 'c1')
    expect(syncAccount).toHaveBeenCalledTimes(1)
  })
})
