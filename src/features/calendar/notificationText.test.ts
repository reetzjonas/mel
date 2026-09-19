import { describe, expect, it } from 'vitest'
import type { CalendarEvent, EventNotification } from '../../domain/calendar'
import { notificationText } from './notificationText'

const note = (over: Partial<EventNotification> = {}): EventNotification => ({
  id: 'n',
  created: '2026-09-19T10:00:00Z',
  kind: 'accepted',
  by: 'Bob',
  byEmail: 'bob@x',
  eventId: 'e1',
  title: 'From the notification',
  comment: '',
  ...over,
})

describe('notificationText', () => {
  it('names who did what to which event', () => {
    expect(notificationText(note(), undefined)).toBe('Bob accepted “From the notification”')
  })

  it('has a sentence for every kind', () => {
    const kinds = ['invited', 'accepted', 'declined', 'tentative', 'changed', 'cancelled'] as const
    const texts = kinds.map((kind) => notificationText(note({ kind }), undefined))
    expect(new Set(texts).size).toBe(kinds.length)
    for (const text of texts) expect(text).not.toMatch(/[{}]/)
  })

  it('prefers the event as it stands now over the title it had when the notification was made', () => {
    const event = { title: 'Renamed' } as CalendarEvent
    expect(notificationText(note(), event)).toContain('“Renamed”')
  })

  it('says something for a nameless sender or an untitled event', () => {
    const text = notificationText(note({ by: '', title: '' }), undefined)
    expect(text).not.toMatch(/[{}]/)
    expect(text).toContain('Someone')
    expect(text).toContain('(no title)')
  })
})
