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

export type ParticipationStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative'

/**
 * An attendee of a scheduled event (RFC 8984 Participant). Addresses are stored
 * bare; the "mailto:" prefix JMAP uses is a transport detail of the mapper.
 */
export interface Participant {
  /** Key in the server's participant map; generated locally for new invitees. */
  id: string
  email: string
  name: string
  /** The organizer. Exactly one participant carries this on a scheduled event. */
  isOrganizer: boolean
  /** false → optional attendee. */
  required: boolean
  status: ParticipationStatus
  /** The organizer wants an RSVP from this participant. */
  expectReply: boolean
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
  /** Empty for a plain, unscheduled event. */
  participants: Participant[]
  /**
   * false when this is an invitation copy the server created for us and someone
   * else organizes it — we may RSVP, but not edit or invite.
   */
  isOrganizerCopy: boolean
}

export interface Occurrence {
  eventId: string
  /** UTC instants. */
  start: Date
  end: Date
  allDay: boolean
}
