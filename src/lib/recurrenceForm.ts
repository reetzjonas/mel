import type { RecurrenceRule } from '../domain/calendar'

export type Frequency = RecurrenceRule['frequency']
export type RepeatEnd = 'never' | 'count' | 'until'

/** JSCalendar day codes in the order a week is shown, Monday first. */
export const DAY_CODES = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const

/**
 * What the recurrence controls in the EventDialog edit, flattened into plain
 * values a form can bind to. `RecurrenceRule` is the wire shape; this is the
 * shape of the *controls*, and `ruleOf` / `formOf` translate between the two.
 */
export interface RepeatForm {
  /** null → the event does not repeat. */
  frequency: Frequency | null
  interval: number
  /** Weekly only: the weekdays the event falls on. */
  byDay: string[]
  end: RepeatEnd
  count: number
  /** Last day of the series, as a date ("2026-12-31"). */
  until: string
}

const DEFAULT_COUNT = 10

/** The weekday code of a local date ("2026-08-03" → "mo"). */
export function dayCodeOfDate(date: string): string {
  const dow = new Date(`${date.slice(0, 10)}T12:00:00Z`).getUTCDay()
  return DAY_CODES[(dow + 6) % 7]!
}

function addMonth(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + 1)
  return d.toISOString().slice(0, 10)
}

function inWeekOrder(days: string[]): string[] {
  return DAY_CODES.filter((code) => days.includes(code))
}

export function formOf(rule: RecurrenceRule | null, startDate: string): RepeatForm {
  const own = dayCodeOfDate(startDate)
  const base: RepeatForm = {
    frequency: null,
    interval: 1,
    byDay: [own],
    end: 'never',
    count: DEFAULT_COUNT,
    until: addMonth(startDate),
  }
  if (!rule) return base
  const days = rule.frequency === 'weekly' && rule.byDay?.length ? rule.byDay : [own]
  return {
    frequency: rule.frequency,
    interval: rule.interval && rule.interval > 0 ? rule.interval : 1,
    byDay: inWeekOrder(days.map((d) => d.toLowerCase())),
    end: rule.count ? 'count' : rule.until ? 'until' : 'never',
    count: rule.count ?? DEFAULT_COUNT,
    until: rule.until ? rule.until.slice(0, 10) : base.until,
  }
}

/**
 * The rule the controls describe. `base` is the event's existing rule: its
 * `byMonthDay` (and a `byDay` on a non-weekly rule, like "the second Tuesday")
 * has no control here and must survive an edit of something else, so it is kept
 * as long as the frequency is the one it was written for.
 */
export function ruleOf(
  form: RepeatForm,
  startDate: string,
  base: RecurrenceRule | null,
): RecurrenceRule | null {
  if (!form.frequency) return null
  const rule: RecurrenceRule = { frequency: form.frequency }
  if (form.interval > 1) rule.interval = form.interval
  if (form.frequency === 'weekly') {
    rule.byDay = form.byDay.length ? inWeekOrder(form.byDay) : [dayCodeOfDate(startDate)]
  } else if (base?.frequency === form.frequency) {
    if (base.byDay) rule.byDay = base.byDay
    if (base.byMonthDay) rule.byMonthDay = base.byMonthDay
  }
  if (form.end === 'count') rule.count = form.count
  // End of day, so the last day itself still gets its occurrence.
  if (form.end === 'until') rule.until = `${form.until}T23:59:59`
  return rule
}

/** Whether the two forms describe the same rule. */
export function sameForm(a: RepeatForm, b: RepeatForm): boolean {
  if (a.frequency !== b.frequency) return false
  if (!a.frequency) return true
  return (
    a.interval === b.interval &&
    a.end === b.end &&
    (a.end !== 'count' || a.count === b.count) &&
    (a.end !== 'until' || a.until === b.until) &&
    (a.frequency !== 'weekly' || a.byDay.join() === b.byDay.join())
  )
}

export type RepeatError = 'interval' | 'count' | 'until' | 'days'

/** The first thing wrong with the controls, or null when they can be saved. */
export function repeatError(form: RepeatForm, startDate: string): RepeatError | null {
  if (!form.frequency) return null
  if (!Number.isInteger(form.interval) || form.interval < 1) return 'interval'
  if (form.frequency === 'weekly' && form.byDay.length === 0) return 'days'
  if (form.end === 'count' && (!Number.isInteger(form.count) || form.count < 1)) return 'count'
  if (form.end === 'until' && (!form.until || form.until < startDate)) return 'until'
  return null
}

/**
 * A lone weekday that is just the start date's own follows the start date; a
 * chosen set does not. Whatever the frequency: the weekday is seeded when the
 * dialog opens, so a date changed before "weekly" is picked would otherwise
 * leave the series repeating on the day the dialog opened with.
 */
export function followStartDay(form: RepeatForm, oldDate: string, newDate: string): RepeatForm {
  if (form.byDay.length !== 1 || form.byDay[0] !== dayCodeOfDate(oldDate)) return form
  return { ...form, byDay: [dayCodeOfDate(newDate)] }
}
