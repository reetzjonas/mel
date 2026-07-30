export interface Calendar {
  id: string
  name: string
  color: string | null
  isDefault: boolean
  mayWrite: boolean
  mayDelete: boolean
}

/** Subset of JSCalendar RecurrenceRule (RFC 8984) we support. */
export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval?: number
  count?: number
  /** Local date-time, like JSCalendar `until`. */
  until?: string
  /** Two-letter day codes (mo, tu, …). */
  byDay?: string[]
  byMonthDay?: number[]
}

export interface CalendarEvent {
  id: string
  calendarIds: Record<string, true>
  uid: string
  title: string
  description: string
  location: string
  /** JSCalendar local date-time without offset ("2026-08-03T10:00:00"). */
  start: string
  /** IANA zone; null → floating (interpreted in the viewer's zone). */
  timeZone: string | null
  /** ISO 8601 duration ("PT1H"). */
  duration: string
  /** All-day events. */
  showWithoutTime: boolean
  status: 'confirmed' | 'cancelled' | 'tentative'
  recurrenceRule: RecurrenceRule | null
}

export interface Occurrence {
  eventId: string
  /** UTC instants. */
  start: Date
  end: Date
  allDay: boolean
}
