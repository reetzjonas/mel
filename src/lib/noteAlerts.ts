import type { Note } from '../domain/note'
import type { PendingAlert } from './alerts'

/*
 * Reminders for notes with a due date (#88), shown by the same service as the
 * calendar's (services/eventReminders.ts).
 *
 * A due date is a plain day with no time, so the reminder has to pick one: the
 * morning of that day, in the viewer's zone. Like an event's, it is caught up
 * when mel next runs, as long as the day has not ended — a note due today is
 * still worth a word at 3 pm, one due yesterday is what the red date in the
 * list is for.
 */

/** The hour, local time, at which a note due that day is brought up. */
export const NOTE_REMINDER_HOUR = 9

function localDay(due: string, dayOffset = 0, hour = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayOffset, hour)
}

/** The reminders for notes due within the horizon, earliest first. */
export function pendingNoteAlerts(notes: Note[], now: Date, horizonMs: number): PendingAlert[] {
  const until = now.getTime() + horizonMs
  const out: PendingAlert[] = []
  for (const note of notes) {
    if (!note.due) continue
    const start = localDay(note.due)
    const end = localDay(note.due, 1)
    const fireAt = localDay(note.due, 0, NOTE_REMINDER_HOUR)
    if (!start || !end || !fireAt) continue
    if (end <= now || fireAt.getTime() > until) continue
    out.push({
      // The date is part of the key, so moving the due date reminds again.
      key: `note|${note.id}|${note.due}`,
      eventId: note.id,
      title: note.title,
      location: '',
      start,
      end,
      allDay: true,
      fireAt,
      kind: 'note',
    })
  }
  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
}
