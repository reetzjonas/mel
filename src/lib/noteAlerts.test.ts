import { describe, expect, it } from 'vitest'
import type { Note } from '../domain/note'
import { NOTE_REMINDER_HOUR, pendingNoteAlerts } from './noteAlerts'

const HORIZON = 36 * 3_600_000

function note(id: string, due: string | null, title = id): Note {
  return {
    id,
    folderId: id,
    fileId: id,
    folderName: id,
    title,
    body: '',
    pinned: false,
    due,
    linkedTo: null,
    extra: {},
    modified: '2026-09-20T12:00:00Z',
  }
}

describe('reminders for due notes', () => {
  it('falls due on the morning of the date, local time', () => {
    const [alert] = pendingNoteAlerts([note('n', '2026-09-21')], new Date(2026, 8, 20, 12), HORIZON)
    expect(alert?.fireAt).toEqual(new Date(2026, 8, 21, NOTE_REMINDER_HOUR))
    expect(alert).toMatchObject({ kind: 'note', eventId: 'n', allDay: true })
  })

  it('is caught up until the day ends, and not after', () => {
    const notes = [note('n', '2026-09-20')]
    expect(pendingNoteAlerts(notes, new Date(2026, 8, 20, 23, 59), HORIZON)).toHaveLength(1)
    expect(pendingNoteAlerts(notes, new Date(2026, 8, 21, 0, 0), HORIZON)).toHaveLength(0)
  })

  it('leaves out undated notes and dates beyond the horizon, earliest first', () => {
    const now = new Date(2026, 8, 20, 8)
    const alerts = pendingNoteAlerts(
      [
        note('later', '2026-09-21'),
        note('none', null),
        note('far', '2026-10-01'),
        note('soon', '2026-09-20'),
      ],
      now,
      HORIZON,
    )
    expect(alerts.map((a) => a.eventId)).toEqual(['soon', 'later'])
  })

  it('reminds again when the date moves', () => {
    const now = new Date(2026, 8, 20, 8)
    const [a] = pendingNoteAlerts([note('n', '2026-09-20')], now, HORIZON)
    const [b] = pendingNoteAlerts([note('n', '2026-09-21')], now, HORIZON)
    expect(a?.key).not.toBe(b?.key)
  })
})
