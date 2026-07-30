import { Temporal } from 'temporal-polyfill'
import { Frequency, RRule, Weekday } from 'rrule'
import type { CalendarEvent, Occurrence, RecurrenceRule } from '../domain/calendar'

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

export function expandOccurrences(
  event: CalendarEvent,
  windowStartUtc: Date,
  windowEndUtc: Date,
  viewerZone: string,
): Occurrence[] {
  const zone = event.timeZone ?? viewerZone
  const durMs = durationMs(event.duration)

  const toOccurrence = (fakeStart: Date): Occurrence => {
    const start = event.showWithoutTime
      ? fakeUtcToInstant(fakeStart, viewerZone)
      : fakeUtcToInstant(fakeStart, zone)
    return {
      eventId: event.id,
      start,
      end: new Date(start.getTime() + Math.max(durMs, event.showWithoutTime ? 86_400_000 : 0)),
      allDay: event.showWithoutTime,
    }
  }

  if (!event.recurrenceRule) {
    const occ = toOccurrence(localToFakeUtc(event.start))
    return occ.end > windowStartUtc && occ.start < windowEndUtc ? [occ] : []
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
  return rule
    .between(fakeFrom, fakeTo, true)
    .slice(0, MAX_OCCURRENCES)
    .map(toOccurrence)
    .filter((o) => o.end > windowStartUtc && o.start < windowEndUtc)
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
