import { Temporal } from 'temporal-polyfill'
import type { CalendarEvent, RecurrenceRule } from '../domain/calendar'

/**
 * Minimal iCalendar (RFC 5545) reader for the one case the app needs: an .ics
 * part hanging off a message, turned into something we can put in a calendar.
 *
 * Deliberately not a full implementation — no VTIMEZONE definitions, no
 * VALARM, no per-occurrence overrides. Anything it cannot read it leaves out
 * rather than guessing, and a payload without a start date is no event at all.
 */

/** An event read out of an .ics part — the calendar it lands in is the user's choice. */
export type IcsEvent = Omit<CalendarEvent, 'id' | 'calendarIds'>

export interface IcsAddress {
  name: string
  email: string
}

export interface IcsInvitation {
  /** iTIP METHOD, uppercased ("REQUEST", "CANCEL", "REPLY"); null if absent. */
  method: string | null
  organizer: IcsAddress | null
  attendees: IcsAddress[]
  event: IcsEvent
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** Local date-time plus how it is anchored, as the ICS spelled it. */
interface IcsDate {
  /** "2026-08-03T10:00:00" — never carries an offset. */
  local: string
  /** IANA zone, "UTC" for a Z value, null when floating or date-only. */
  zone: string | null
  dateOnly: boolean
}

/** Undo RFC 5545 line folding: a CRLF followed by one space or tab is nothing. */
function unfold(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '')
}

function parseProp(line: string): Prop | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 1) return null
  const value = line.slice(colon + 1)
  // Name and parameters, split on unquoted semicolons. Quotes only group the
  // value of a parameter, so they can be dropped as we go.
  const segments: string[] = []
  let current = ''
  quoted = false
  for (const c of line.slice(0, colon)) {
    if (c === '"') quoted = !quoted
    else if (c === ';' && !quoted) {
      segments.push(current)
      current = ''
    } else current += c
  }
  segments.push(current)
  const params: Record<string, string> = {}
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=')
    if (eq > 0) params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1)
  }
  return { name: segments[0]!.trim().toUpperCase(), params, value }
}

/** RFC 5545 TEXT escaping: \n is a newline, the rest are literal characters. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** A zone we cannot resolve (Windows names, bogus ids) is worse than none. */
function usableZone(id: string | undefined): string | null {
  if (!id) return null
  try {
    Temporal.PlainDateTime.from('2000-01-01T00:00:00').toZonedDateTime(id)
    return id
  } catch {
    return null
  }
}

function parseDate(prop: Prop): IcsDate | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value.trim())
  if (!m) return null
  const [, y, mo, d, hh, mm, ss, z] = m
  const dateOnly = prop.params['VALUE'] === 'DATE' || hh === undefined
  return {
    local: `${y}-${mo}-${d}T${dateOnly ? '00:00:00' : `${hh}:${mm}:${ss}`}`,
    zone: dateOnly ? null : z ? 'UTC' : usableZone(prop.params['TZID']),
    dateOnly,
  }
}

/**
 * DTEND is exclusive, so the gap between the two is the duration. Zoned ends
 * are measured as instants (a meeting across a DST switch really is an hour
 * longer); floating ones only have wall clock to go on.
 */
function durationBetween(start: IcsDate, end: IcsDate): string {
  if (start.dateOnly) {
    const days = Temporal.PlainDate.from(start.local.slice(0, 10)).until(
      Temporal.PlainDate.from(end.local.slice(0, 10)),
    ).days
    return `P${Math.max(1, days)}D`
  }
  try {
    const diff =
      start.zone && end.zone
        ? Temporal.PlainDateTime.from(start.local)
            .toZonedDateTime(start.zone)
            .until(Temporal.PlainDateTime.from(end.local).toZonedDateTime(end.zone), {
              largestUnit: 'hour',
            })
        : Temporal.PlainDateTime.from(start.local).until(Temporal.PlainDateTime.from(end.local), {
            largestUnit: 'hour',
          })
    return diff.sign > 0 ? diff.toString() : 'PT1H'
  } catch {
    return 'PT1H'
  }
}

function parseDuration(value: string): string | null {
  try {
    const d = Temporal.Duration.from(value.trim())
    return d.sign > 0 ? d.toString() : null
  } catch {
    return null
  }
}

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const

function parseRule(value: string): RecurrenceRule | null {
  const parts: Record<string, string> = {}
  for (const piece of value.split(';')) {
    const eq = piece.indexOf('=')
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1)
  }
  const frequency = (parts['FREQ'] ?? '').toLowerCase()
  // Sub-daily frequencies exist in RFC 5545 but not in what we can store or
  // expand; an event we would render wrongly is better left non-repeating.
  if (!FREQUENCIES.some((f) => f === frequency)) return null
  const rule: RecurrenceRule = { frequency: frequency as RecurrenceRule['frequency'] }
  const interval = Number(parts['INTERVAL'])
  if (Number.isInteger(interval) && interval > 1) rule.interval = interval
  const count = Number(parts['COUNT'])
  if (Number.isInteger(count) && count > 0) rule.count = count
  if (parts['UNTIL']) {
    const until = parseDate({ name: 'UNTIL', params: {}, value: parts['UNTIL'] })
    if (until) rule.until = until.local
  }
  if (parts['BYDAY']) {
    // "-1SU" (last Sunday) keeps only its day code: the nth-of-period half has
    // no home in our rule, and dropping it repeats weekly instead of wrongly.
    const days = parts['BYDAY']
      .split(',')
      .map((d) =>
        d
          .trim()
          .replace(/^[+-]?\d+/, '')
          .toLowerCase(),
      )
      .filter((d) => /^(mo|tu|we|th|fr|sa|su)$/.test(d))
    if (days.length) rule.byDay = days
  }
  if (parts['BYMONTHDAY']) {
    const days = parts['BYMONTHDAY']
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d) && d !== 0)
    if (days.length) rule.byMonthDay = days
  }
  return rule
}

/** ORGANIZER/ATTENDEE carry a CAL-ADDRESS; only mailto ones mean anything here. */
function parseAddress(prop: Prop): IcsAddress | null {
  const value = prop.value.trim()
  const email = (/^mailto:(.+)$/i.exec(value)?.[1] ?? value).trim()
  if (!email.includes('@')) return null
  return { name: unescapeText(prop.params['CN'] ?? '').trim(), email }
}

const STATUSES: Record<string, CalendarEvent['status']> = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  TENTATIVE: 'tentative',
}

/**
 * Read the first event out of an .ics payload, or null if there is none we can
 * use. Overrides of single occurrences (RECURRENCE-ID) lose to the master
 * event when the payload carries both.
 */
export function parseIcs(text: string): IcsInvitation | null {
  let method: string | null = null
  const blocks: Prop[][] = []
  let block: Prop[] | null = null
  /** Nesting inside the current VEVENT — VALARM and friends are skipped whole. */
  let nested = 0

  for (const line of unfold(text).split('\n')) {
    const prop = parseProp(line.trim())
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      if (block) nested++
      else if (prop.value.trim().toUpperCase() === 'VEVENT') block = []
      continue
    }
    if (prop.name === 'END') {
      if (block && nested === 0 && prop.value.trim().toUpperCase() === 'VEVENT') {
        blocks.push(block)
        block = null
      } else if (block) nested--
      continue
    }
    if (block) {
      if (nested === 0) block.push(prop)
    } else if (prop.name === 'METHOD') method = prop.value.trim().toUpperCase()
  }

  if (!blocks.length) return null
  const props = blocks.find((b) => !b.some((p) => p.name === 'RECURRENCE-ID')) ?? blocks[0]!
  const first = (name: string) => props.find((p) => p.name === name)
  const textOf = (name: string) => unescapeText(first(name)?.value ?? '').trim()

  const dtstart = first('DTSTART')
  const start = dtstart ? parseDate(dtstart) : null
  if (!start) return null

  const dtend = first('DTEND')
  const end = dtend ? parseDate(dtend) : null
  const duration =
    (first('DURATION') ? parseDuration(first('DURATION')!.value) : null) ??
    (end ? durationBetween(start, end) : null) ??
    (start.dateOnly ? 'P1D' : 'PT1H')

  const rrule = first('RRULE')
  const organizer = first('ORGANIZER')

  return {
    method,
    organizer: organizer ? parseAddress(organizer) : null,
    attendees: props
      .filter((p) => p.name === 'ATTENDEE')
      .map(parseAddress)
      .filter((a): a is IcsAddress => a !== null),
    event: {
      uid: textOf('UID'),
      title: textOf('SUMMARY'),
      description: textOf('DESCRIPTION'),
      location: textOf('LOCATION'),
      start: start.local,
      timeZone: start.zone,
      duration,
      showWithoutTime: start.dateOnly,
      status: STATUSES[textOf('STATUS').toUpperCase()] ?? 'confirmed',
      recurrenceRule: rrule ? parseRule(rrule.value) : null,
      /*
       * Attendees are read for display only and never stored on the copy we
       * create. An event that carries participants is a *scheduled* one, and
       * the server would mail an iTIP invitation to every address on it —
       * putting a message in someone else's inbox because we filed an
       * appointment in ours.
       */
      participants: [],
      isOrganizerCopy: true,
    },
  }
}
