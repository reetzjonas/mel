import { Temporal } from 'temporal-polyfill'
import { Frequency, RRule, Weekday } from 'rrule'
import type { CalendarEvent, Occurrence, RecurrenceRule } from '../domain/calendar'
import { isExcluded, occurrenceEvent } from './occurrence'

/**
 * Recurrence expansion. rrule has known DST edge cases, so we never let it
 * touch real timezones: occurrences are generated in *wall-clock* time
 * (local date-times treated as fake-UTC) and each one is then anchored to
 * the event's IANA zone via Temporal. This keeps "10:00 every Monday"
 * at 10:00 across DST transitions.
 */

const FREQ: Record<RecurrenceRule['frequency'], Frequency> = {
  daily: RRule.DAILY,
  weekly: RRule.WEEKLY,
  monthly: RRule.MONTHLY,
  yearly: RRule.YEARLY,
}

const DAYS: Record<string, Weekday> = {
  mo: RRule.MO,
  tu: RRule.TU,
  we: RRule.WE,
  th: RRule.TH,
  fr: RRule.FR,
  sa: RRule.SA,
  su: RRule.SU,
}

function localToFakeUtc(local: string): Date {
  // "2026-08-03T10:00:00" → Date holding that wall time as if it were UTC.
  return new Date(`${local}Z`)
}

function fakeUtcToInstant(fake: Date, timeZone: string): Date {
  const pdt = Temporal.PlainDateTime.from(fake.toISOString().slice(0, 19))
  return new Date(pdt.toZonedDateTime(timeZone).epochMilliseconds)
}

export function parseDuration(iso: string): Temporal.Duration {
  try {
    return Temporal.Duration.from(iso || 'PT0S')
  } catch {
    return Temporal.Duration.from('PT0S')
  }
}

function durationMs(iso: string): number {
  return parseDuration(iso).total({ unit: 'milliseconds' })
}

const MAX_OCCURRENCES = 500

/** The local date-time an occurrence is keyed by, from its fake-UTC start. */
function recurrenceIdOf(fakeStart: Date): string {
  return fakeStart.toISOString().slice(0, 19)
}

export function expandOccurrences(
  event: CalendarEvent,
  windowStartUtc: Date,
  windowEndUtc: Date,
  viewerZone: string,
): Occurrence[] {
  const durMs = durationMs(event.duration)

  const toOccurrence = (
    fakeStart: Date,
    recurrenceId: string | null = null,
    forEvent: CalendarEvent = event,
  ): Occurrence => {
    const start = forEvent.showWithoutTime
      ? fakeUtcToInstant(fakeStart, viewerZone)
      : fakeUtcToInstant(fakeStart, forEvent.timeZone ?? viewerZone)
    const ms = forEvent === event ? durMs : durationMs(forEvent.duration)
    return {
      eventId: event.id,
      recurrenceId,
      start,
      end: new Date(start.getTime() + Math.max(ms, forEvent.showWithoutTime ? 86_400_000 : 0)),
      allDay: forEvent.showWithoutTime,
    }
  }

  if (!event.recurrenceRule) {
    const occ = toOccurrence(localToFakeUtc(event.start))
    return occ.end > windowStartUtc && occ.start < windowEndUtc ? [occ] : []
  }

  const overrides = event.recurrenceOverrides ?? {}

  /*
   * An overridden occurrence is built from its patch instead of the rule, and
   * every override is considered whatever the window is: one may have been
   * moved *into* view from a date the rule's own window does not reach, and a
   * recurrence id the rule never produces is an occurrence in its own right
   * (RFC 8984 allows an override to add one).
   */
  const overridden: Occurrence[] = []
  for (const [recurrenceId, patch] of Object.entries(overrides)) {
    if (isExcluded(patch)) continue
    const moved = occurrenceEvent(event, recurrenceId)
    if (!moved.start) continue
    overridden.push(toOccurrence(localToFakeUtc(moved.start), recurrenceId, moved))
  }

  const r = event.recurrenceRule
  const rule = new RRule({
    freq: FREQ[r.frequency],
    interval: r.interval ?? 1,
    count: r.count ? Math.min(r.count, MAX_OCCURRENCES) : undefined,
    until: r.until ? localToFakeUtc(r.until) : undefined,
    byweekday: r.byDay?.map((d) => DAYS[d.toLowerCase()]).filter((d): d is Weekday => !!d),
    bymonthday: r.byMonthDay,
    dtstart: localToFakeUtc(event.start),
  })

  // Widen the fake-UTC window by a day to survive the wall-clock/zone offset.
  const fakeFrom = new Date(windowStartUtc.getTime() - 86_400_000 - durMs)
  const fakeTo = new Date(windowEndUtc.getTime() + 86_400_000)
  const plain = rule
    .between(fakeFrom, fakeTo, true)
    .slice(0, MAX_OCCURRENCES)
    .filter((fake) => !(recurrenceIdOf(fake) in overrides))
    .map((fake) => toOccurrence(fake, recurrenceIdOf(fake)))

  return [...plain, ...overridden].filter((o) => o.end > windowStartUtc && o.start < windowEndUtc)
}

/** Occurrences of many events, sorted by start. */
export function expandAll(
  events: CalendarEvent[],
  windowStartUtc: Date,
  windowEndUtc: Date,
  viewerZone: string,
): Occurrence[] {
  const out: Occurrence[] = []
  for (const e of events) {
    if (e.status === 'cancelled') continue
    out.push(...expandOccurrences(e, windowStartUtc, windowEndUtc, viewerZone))
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

/**
 * The event as it stands after being dragged to a new place on the grid.
 *
 * The grid works in the viewer's wall clock; the event stores its own. So a
 * dropped instant has to be *read back* in the event's zone rather than
 * re-serialised from the viewer's: a 10:00 Berlin meeting dragged while the
 * calendar is being read in London must still be stored as 10:00, or it walks
 * an hour every time someone travels.
 *
 * The duration is rewritten too, since that is the only place an event's
 * length lives — there is no end field to move.
 */
export function rescheduleEvent(
  event: CalendarEvent,
  start: Date,
  end: Date,
  viewerZone: string,
): CalendarEvent {
  const zone = event.timeZone ?? viewerZone
  const local = Temporal.Instant.fromEpochMilliseconds(start.getTime())
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
  const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000))
  return {
    ...event,
    start: local,
    duration: Temporal.Duration.from({ minutes }).round({ largestUnit: 'hour' }).toString(),
  }
}
