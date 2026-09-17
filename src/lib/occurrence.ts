/*
 * Editing one occurrence of a series without touching the rest of it.
 *
 * RFC 8984 keeps these as `recurrenceOverrides`: a map from an occurrence's
 * original local start to a patch of what differs. Everything about that
 * format lives here — reading a patch into an event anyone can edit, turning
 * an edited event back into a patch, and the two ways an edit can be meant
 * ("this one" or "the whole series").
 *
 * Only the fields the event dialog offers are read and written. Anything else
 * a patch carries — another client's fields, the server's `updated` stamp — is
 * left exactly where it was, which is why a patch is an open map rather than a
 * typed object.
 */

import type { CalendarEvent, RecurrencePatch } from '../domain/calendar'

/** The location, which JSCalendar keeps as an object rather than a string. */
const LOCATION_KEY = 'locations'
const LOCATION_POINTER = 'locations/l0/name'

/** Whether this occurrence was taken out of the series. */
export function isExcluded(patch: RecurrencePatch | undefined): boolean {
  return patch?.['excluded'] === true
}

function locationOf(patch: RecurrencePatch): string | undefined {
  // Both spellings occur in the wild: a whole `locations` object, and the JSON
  // pointer into it that a patch may use instead.
  const pointer = patch[LOCATION_POINTER]
  if (typeof pointer === 'string') return pointer
  const locations = patch[LOCATION_KEY]
  if (locations && typeof locations === 'object') {
    const first = Object.values(locations as Record<string, { name?: unknown }>)[0]
    if (typeof first?.name === 'string') return first.name
  }
  return undefined
}

/**
 * The event as one occurrence of it stands: the series with its patch applied.
 *
 * `start` is the occurrence's own start — the recurrence id when nothing moved
 * it — so what comes back can be handed to the dialog, or to the same code
 * that reschedules a one-off event, without either knowing about series.
 */
export function occurrenceEvent(event: CalendarEvent, recurrenceId: string): CalendarEvent {
  const patch = event.recurrenceOverrides[recurrenceId] ?? {}
  // Each field is read and checked by name rather than copied across in a
  // loop: the patch comes off the wire, so a number where a title belongs is
  // something to ignore, not something to put into the event.
  const text = (key: string, fallback: string) =>
    typeof patch[key] === 'string' ? (patch[key] as string) : fallback
  const status = patch['status']
  return {
    ...event,
    start: text('start', recurrenceId),
    duration: text('duration', event.duration),
    title: text('title', event.title),
    description: text('description', event.description),
    location: locationOf(patch) ?? event.location,
    showWithoutTime:
      typeof patch['showWithoutTime'] === 'boolean'
        ? patch['showWithoutTime']
        : event.showWithoutTime,
    status:
      status === 'confirmed' || status === 'cancelled' || status === 'tentative'
        ? status
        : event.status,
  }
}

/**
 * What an edited occurrence differs from the series in, as a patch.
 *
 * Only differences are written: a patch that repeats the series' own title is
 * a title another client can no longer change from the series, which is not
 * what editing the time of one occurrence was meant to say. An existing patch
 * is merged over rather than replaced, so fields mel does not offer survive.
 */
export function patchFor(
  series: CalendarEvent,
  recurrenceId: string,
  edited: CalendarEvent,
): RecurrencePatch {
  const existing = series.recurrenceOverrides[recurrenceId] ?? {}
  const patch: RecurrencePatch = { ...existing }
  // Cleared out, since a stale spelling of the location would win over the new
  // one depending on which the reader looks at first.
  delete patch[LOCATION_KEY]
  delete patch[LOCATION_POINTER]

  const differs = (key: string, value: unknown, seriesValue: unknown) => {
    if (value === seriesValue) delete patch[key]
    else patch[key] = value
  }
  differs('start', edited.start, recurrenceId)
  differs('duration', edited.duration, series.duration)
  differs('title', edited.title, series.title)
  differs('description', edited.description, series.description)
  differs('status', edited.status, series.status)
  differs('showWithoutTime', edited.showWithoutTime, series.showWithoutTime)
  if (edited.location !== series.location) {
    patch[LOCATION_KEY] = { l0: { '@type': 'Location', name: edited.location } }
  }
  return patch
}

/** The series with this occurrence's patch written into it. */
export function withOverride(
  series: CalendarEvent,
  recurrenceId: string,
  patch: RecurrencePatch,
): CalendarEvent {
  return {
    ...series,
    recurrenceOverrides: { ...series.recurrenceOverrides, [recurrenceId]: patch },
  }
}

/** The series with this occurrence taken out of it. */
export function withoutOccurrence(series: CalendarEvent, recurrenceId: string): CalendarEvent {
  return withOverride(series, recurrenceId, { excluded: true })
}

const DAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const

/** The weekday of a local date-time string, as a JSCalendar day code. */
function dayCodeOf(local: string): string | undefined {
  const date = new Date(`${local.slice(0, 10)}T12:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : DAY_CODES[date.getDay()]
}

function daysBetween(fromLocal: string, toLocal: string): number {
  const from = Date.parse(`${fromLocal.slice(0, 10)}T12:00:00Z`)
  const to = Date.parse(`${toLocal.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.round((to - from) / 86_400_000)
}

/**
 * The whole series, changed the way this one occurrence was.
 *
 * A date moved on one occurrence means the series moves by that many days —
 * writing the occurrence's own date as the series start would drop every
 * earlier occurrence instead. The time of day, the length and everything else
 * are taken as they are, since those mean the same on any occurrence.
 *
 * A weekly rule that names its days is rewritten to the new weekday. Without
 * that, dragging a Monday meeting to a Wednesday and choosing "all events"
 * would appear to do nothing at all: the rule would go on producing Mondays.
 */
export function seriesFromOccurrence(
  series: CalendarEvent,
  recurrenceId: string,
  edited: CalendarEvent,
): CalendarEvent {
  const shift = daysBetween(recurrenceId, edited.start)
  const startDate = new Date(`${series.start.slice(0, 10)}T12:00:00Z`)
  startDate.setUTCDate(startDate.getUTCDate() + shift)
  const start = `${startDate.toISOString().slice(0, 10)}T${edited.start.slice(11)}`

  const rule = series.recurrenceRule
  const newDay = dayCodeOf(edited.start)
  const movedWeekday = newDay !== undefined && newDay !== dayCodeOf(recurrenceId)
  const byDay = rule?.byDay?.length === 1 && movedWeekday ? [newDay!] : rule?.byDay

  /*
   * This occurrence's own patch is dropped, because it would go on overriding
   * exactly the change that was just asked for everywhere: editing the title
   * of an occurrence that already had one, and choosing "all events", would
   * otherwise leave that one occurrence showing the old title.
   */
  const { [recurrenceId]: _replaced, ...rest } = series.recurrenceOverrides

  return {
    ...edited,
    start,
    recurrenceRule: rule ? { ...rule, byDay } : null,
    recurrenceOverrides: rest,
  }
}
