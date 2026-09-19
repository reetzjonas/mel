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

/**
 * What one occurrence of a series does differently (RFC 8984 PatchObject).
 *
 * An open map rather than a typed subset, unlike RecurrenceRule above. Its keys
 * are JSON pointers into the event (`locations/l0/name`), servers add their own
 * (Stalwart writes `updated`), and mel rewrites the whole map whenever it saves
 * an event — so a typed shape would quietly throw away whatever another client
 * put there. `excluded: true` means the occurrence does not happen at all.
 */
export type RecurrencePatch = Record<string, unknown>

/**
 * A JSCalendar `alerts` map (RFC 8984 §4.5.2), kept whole.
 *
 * Open like RecurrencePatch, for the same reason: mel edits one kind of alert
 * (a display reminder some minutes before the start) and rewrites the whole map
 * on every save, so an email alert, an absolute trigger or another client's
 * fields have to survive it untouched. `lib/alerts.ts` reads what it needs.
 */
export type EventAlerts = Record<string, Record<string, unknown>>

export type FreeBusyStatus = 'busy' | 'free'
export type EventPrivacy = 'public' | 'private' | 'secret'

/**
 * A JSCalendar `links` map (RFC 8984 §4.2.7), kept whole.
 *
 * Open like `alerts`, for the same reason: mel edits the attachments in it
 * (`rel: "enclosure"`) and rewrites the whole map on every save, so a link that
 * is not an attachment, or a field another client put on one, has to come back
 * untouched. `lib/attachments.ts` reads what it needs.
 */
export type EventLinks = Record<string, Record<string, unknown>>

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

/**
 * What someone else did to an event we are part of (JMAP CalendarEventNotification).
 *
 * `kind` is worked out when the notification is read, from the server's own
 * `type` and — for an update — from what the person who made it did to their
 * own participation: someone accepting an invitation and someone rewriting the
 * agenda are both `updated` on the wire, and only the first is worth a line of
 * its own.
 */
export type NotificationKind =
  'invited' | 'accepted' | 'declined' | 'tentative' | 'changed' | 'cancelled'

export interface EventNotification {
  id: string
  /** UTC, ISO 8601. */
  created: string
  kind: NotificationKind
  /** Who did it: their name, or their address when they have none. */
  by: string
  byEmail: string
  /** null when the server names no event (or it has since gone). */
  eventId: string | null
  /** The event's title as the notification carried it; empty when it did not. */
  title: string
  /** Free text the sender attached; empty for none. */
  comment: string
}

export interface CalendarEvent {
  id: string
  calendarIds: Record<string, true>
  uid: string
  title: string
  description: string
  location: string
  /**
   * Link to an online meeting (the first JSCalendar `virtualLocations` entry).
   * Optional for the same reason as `alerts`: a row synced before it was read
   * has none, and "unknown" must not be written back as "cleared".
   */
  meetingUrl?: string
  /**
   * Whether the event blocks time (RFC 8984 `freeBusyStatus`, default busy).
   * Optional like `meetingUrl`: a row synced before it was read has none.
   */
  freeBusyStatus?: FreeBusyStatus
  /** Who may see the details when the calendar is shared (`privacy`, default public). */
  privacy?: EventPrivacy
  /** Free-form tags on the event itself, apart from its calendar's colour. */
  categories?: string[]
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
  /**
   * Changes to single occurrences, keyed by the occurrence's *original* local
   * start — the one the rule produced, which stays the key even after the
   * occurrence has been moved somewhere else.
   */
  recurrenceOverrides: Record<string, RecurrencePatch>
  /**
   * Reminders; the same for every occurrence of a series. Optional because rows
   * synced before alerts were read have none, and a delta sync does not rewrite
   * an event that did not change.
   */
  alerts?: EventAlerts
  /** Attachments and other links; optional for the same reason as `alerts`. */
  links?: EventLinks
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
  /**
   * Which occurrence of a series this is, as its original local start; null for
   * an event that does not recur. It is the key an override is written under,
   * so it identifies the occurrence even once it has been moved.
   */
  recurrenceId: string | null
  /** UTC instants. */
  start: Date
  end: Date
  allDay: boolean
}
