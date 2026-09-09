import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../domain/calendar'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'
import { createEvent, updateEvent } from './calendar'

const createdEvents: Array<CalendarEvent> = []
const enqueued: Array<Record<string, unknown>> = []

vi.mock('../sync/connections', () => ({
  connectionFor: (_accountId: string) =>
    Promise.resolve({
      calendars: {
        createEvent: (ev: CalendarEvent) => {
          createdEvents.push(ev)
          return Promise.resolve({ id: 'srv-1', failure: null })
        },
      },
    }),
}))

vi.mock('../sync/outbox', () => ({
  enqueue: (_accountId: string, action: Record<string, unknown>) => {
    enqueued.push(action)
    return Promise.resolve(1)
  },
}))

const ACC = 'acc-test'

const sampleEvent: Omit<CalendarEvent, 'id'> = {
  calendarIds: { cal1: true },
  uid: '',
  title: 'Test Meeting',
  description: '',
  location: '',
  start: '2026-10-15T10:00:00',
  timeZone: 'UTC',
  duration: 'PT1H',
  showWithoutTime: false,
  status: 'confirmed',
  recurrenceRule: null,
  participants: [],
  isOrganizerCopy: true,
}

describe('calendar service', () => {
  beforeEach(async () => {
    createdEvents.length = 0
    enqueued.length = 0
    await db.events.clear()
  })

  it('assigns a valid uid on createEvent and persists it locally and remotely', async () => {
    const id = await createEvent(ACC, sampleEvent)

    expect(id).toBe('srv-1')
    expect(createdEvents).toHaveLength(1)
    expect(createdEvents[0]!.uid).toBeTruthy()
    expect(createdEvents[0]!.uid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )

    const row = await db.events.get([ACC, 'srv-1'])
    expect(row).toBeDefined()
    const stored = openEnvelope<CalendarEvent>(row!.payload)
    expect(stored.uid).toBe(createdEvents[0]!.uid)
  })

  it('enqueues updateEvent and updates local DB', async () => {
    const event: CalendarEvent = { ...sampleEvent, id: 'srv-1', uid: 'uid-abc' }
    await updateEvent(ACC, event)

    const row = await db.events.get([ACC, 'srv-1'])
    expect(row).toBeDefined()
    const stored = openEnvelope<CalendarEvent>(row!.payload)
    expect(stored.uid).toBe('uid-abc')

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!['kind']).toBe('event.update')
  })
})
