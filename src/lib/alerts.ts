import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent, EventAlerts, Occurrence } from '../domain/calendar'
import { expandOccurrences } from './recurrence'
import { occurrenceEvent } from './occurrence'

/*
 * Event reminders (JSCalendar `alerts`, RFC 8984 §4.5.2).
 *
 * The map is kept whole on the event (see EventAlerts) and read here. Two
 * halves: the small vocabulary the event dialog offers ("15 minutes before"),
 * and working out which alerts of which occurrences are due — the part the
 * reminder service acts on, kept pure so DST, series and offline catch-up can
 * be tested without a clock or a notification.
 */

/** Minutes before the start the dialog offers, in the order it lists them. */
export const REMINDER_PRESETS: readonly number[] = [0, 5, 10, 15, 30, 60, 120, 1440, 2880]

/** The key mel gives an alert it creates. */
const OWN_KEY = 'mel-reminder'

/** Alerts further ahead than this are not looked for; the plan is redone as time passes. */
const MAX_LEAD_MS = 30 * 86_400_000

interface OffsetTrigger {
  offset: Temporal.Duration
  relativeTo: 'start' | 'end'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Only a display alert is ours to show; `email` is the server's to send. */
const isDisplay = (alert: Record<string, unknown>) =>
  alert['action'] === undefined || alert['action'] === 'display'

function offsetTrigger(alert: Record<string, unknown>): OffsetTrigger | null {
  const trigger = alert['trigger']
  if (!isRecord(trigger) || typeof trigger['offset'] !== 'string') return null
  if (trigger['@type'] !== undefined && trigger['@type'] !== 'OffsetTrigger') return null
  try {
    return {
      offset: Temporal.Duration.from(trigger['offset']),
      relativeTo: trigger['relativeTo'] === 'end' ? 'end' : 'start',
    }
  } catch {
    return null
  }
}

/** Whether the map is a map of objects, which is all the mapper checks. */
export function toAlerts(raw: unknown): EventAlerts {
  const out: EventAlerts = {}
  if (!isRecord(raw)) return out
  for (const [id, alert] of Object.entries(raw)) if (isRecord(alert)) out[id] = alert
  return out
}

/**
 * The reminder the dialog can show: a display alert some whole minutes before
 * the start. Anything else — after the start, relative to the end, a odd
 * number of seconds — is not offered and so is left exactly as it is.
 */
export function reminderOf(alerts: EventAlerts): { key: string; minutes: number } | null {
  for (const [key, alert] of Object.entries(alerts)) {
    if (!isDisplay(alert)) continue
    const t = offsetTrigger(alert)
    if (!t || t.relativeTo !== 'start') continue
    if (t.offset.sign > 0) continue
    // The fields of a negative duration are negative themselves.
    const { days, weeks, hours, minutes, seconds } = t.offset.abs()
    if (seconds !== 0) continue
    const total = weeks * 10_080 + days * 1440 + hours * 60 + minutes
    if (Number.isInteger(total)) return { key, minutes: total }
  }
  return null
}

/** The map with its one editable reminder set to this, or removed for `null`. */
export function withReminder(alerts: EventAlerts, minutes: number | null): EventAlerts {
  const current = reminderOf(alerts)
  const out = { ...alerts }
  if (current) delete out[current.key]
  if (minutes === null) return out
  out[current?.key ?? OWN_KEY] = {
    '@type': 'Alert',
    trigger: {
      '@type': 'OffsetTrigger',
      offset: minutes === 0 ? 'PT0S' : `-PT${minutes}M`,
      relativeTo: 'start',
    },
    action: 'display',
  }
  return out
}

/** One alert of one occurrence, with the moment it is due. */
export interface PendingAlert {
  /** Stable across syncs and unchanged until the alert or the occurrence moves. */
  key: string
  eventId: string
  title: string
  location: string
  start: Date
  end: Date
  allDay: boolean
  fireAt: Date
  /** A note's due date (lib/noteAlerts.ts) rather than an event; `eventId` is then the note's id. */
  kind?: 'note'
}

function fireTime(alert: Record<string, unknown>, occ: Occurrence, zone: string): Date | null {
  const trigger = alert['trigger']
  if (isRecord(trigger) && trigger['@type'] === 'AbsoluteTrigger') {
    const when = typeof trigger['when'] === 'string' ? new Date(trigger['when']) : null
    return when && !Number.isNaN(when.getTime()) ? when : null
  }
  const t = offsetTrigger(alert)
  if (!t) return null
  const anchor = (t.relativeTo === 'end' ? occ.end : occ.start).getTime()
  /*
   * Applied to a zoned time rather than to the instant: "1 day before" means
   * the same wall-clock time yesterday, which is not 24 hours across a DST
   * change. The zone is the event's own, so a series keeps its hour.
   */
  return new Date(
    Temporal.Instant.fromEpochMilliseconds(anchor).toZonedDateTimeISO(zone).add(t.offset)
      .epochMilliseconds,
  )
}

/**
 * Every alert due by `now + horizonMs` whose occurrence has not ended yet.
 *
 * Not ended, rather than not started: an alert whose moment passed while the
 * app was closed or the laptop asleep should still be shown once, as long as it
 * is still about something — a meeting already over is no reminder. Sorted by
 * the moment they fall due, so the first one in the future is what to wait for.
 */
export function pendingAlerts(
  events: CalendarEvent[],
  now: Date,
  horizonMs: number,
  viewerZone: string,
): PendingAlert[] {
  const out: PendingAlert[] = []
  const until = new Date(now.getTime() + horizonMs)
  const windowEnd = new Date(until.getTime() + MAX_LEAD_MS)
  for (const event of events) {
    const alerts = event.alerts ?? {}
    if (event.status === 'cancelled' || !Object.keys(alerts).length) continue
    const zone = (!event.showWithoutTime && event.timeZone) || viewerZone
    for (const occ of expandOccurrences(event, now, windowEnd, viewerZone)) {
      const shown = occ.recurrenceId ? occurrenceEvent(event, occ.recurrenceId) : event
      if (shown.status === 'cancelled') continue
      for (const [id, alert] of Object.entries(alerts)) {
        if (!isDisplay(alert)) continue
        const fireAt = fireTime(alert, occ, zone)
        if (!fireAt || fireAt > until) continue
        // Another client already showed and dismissed it (JSCalendar `acknowledged`).
        const ack =
          typeof alert['acknowledged'] === 'string' ? Date.parse(alert['acknowledged']) : NaN
        if (ack >= fireAt.getTime()) continue
        out.push({
          key: `${event.id}|${occ.recurrenceId ?? ''}|${id}|${fireAt.getTime()}`,
          eventId: event.id,
          title: shown.title,
          location: shown.location,
          start: occ.start,
          end: occ.end,
          allDay: occ.allDay,
          fireAt,
        })
      }
    }
  }
  return out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
}
