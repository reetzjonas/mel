import type {
  Calendar,
  CalendarEvent,
  EventNotification,
  Participant,
  ParticipationStatus,
  RecurrencePatch,
  RecurrenceRule,
} from '../../domain/calendar'
import { type CalendarProvider, type SetFailure } from '../types'
import { Batch } from './client/request'
import { JmapError, type Transport } from './client/transport'
import { Cap, type SetError, type SetResponse } from './client/types/core'
import { syncCollection } from './collectionSync'
import { toAlerts } from '../../lib/alerts'
import { toLinks } from '../../lib/attachments'

const USING = [Cap.core, Cap.calendars]

const PERMANENT = new Set([
  'invalidProperties',
  'invalidPatch',
  'notFound',
  'forbidden',
  'overQuota',
])

function toFailure(e: SetError | undefined): SetFailure {
  return {
    type: e?.type ?? 'serverFail',
    description: e?.description,
    permanent: e ? PERMANENT.has(e.type) : false,
  }
}

interface JmapCalendar {
  id: string
  name: string
  color?: string | null
  isDefault?: boolean
  myRights?: { mayWriteAll?: boolean; mayWriteOwn?: boolean; mayDelete?: boolean }
}

export interface JmapCalendarEvent {
  id: string
  calendarIds: Record<string, boolean>
  uid?: string
  title?: string | null
  description?: string | null
  locations?: Record<string, { name?: string | null }> | null
  virtualLocations?: Record<string, { uri?: string | null }> | null
  freeBusyStatus?: string | null
  privacy?: string | null
  categories?: Record<string, boolean> | null
  start?: string
  timeZone?: string | null
  duration?: string
  showWithoutTime?: boolean
  status?: string | null
  recurrenceRule?: {
    frequency: string
    interval?: number
    count?: number
    until?: string
    byDay?: Array<{ day: string }>
    byMonthDay?: number[]
  } | null
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null
  alerts?: Record<string, Record<string, unknown>> | null
  links?: Record<string, Record<string, unknown>> | null
  participants?: Record<string, JmapParticipant> | null
  organizerCalendarAddress?: string | null
  /** false on the invitation copy the server keeps for an attendee. */
  isOrigin?: boolean
}

export interface JmapEventNotification {
  id: string
  created?: string
  changedBy?: { name?: string | null; email?: string | null } | null
  comment?: string | null
  /** "created" | "updated" | "destroyed". */
  type?: string
  calendarEventId?: string | null
  /** The event as it now stands (or its changes) — for RSVPs this carries the participants. */
  eventPatch?: Record<string, unknown> | null
}

interface JmapParticipant {
  '@type'?: string
  name?: string | null
  /** "mailto:someone@example.com" */
  calendarAddress?: string | null
  roles?: Record<string, boolean> | null
  participationStatus?: string | null
  expectReply?: boolean | null
}

const RSVP_KINDS = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
} as const

/**
 * A notification in the terms the UI shows it.
 *
 * Stalwart reports an RSVP as a plain `updated` whose patch holds the whole
 * participant map, with no field saying *what* changed. The person who caused
 * the notification is named though, so their own entry in that map is the
 * answer: if they now say accepted/declined/tentative, that is what they did.
 * Anything else — a moved time, a new agenda — is just "changed".
 */
export function toNotification(n: JmapEventNotification): EventNotification {
  const email = (n.changedBy?.email ?? '').trim()
  const patch = n.eventPatch ?? {}
  let kind: EventNotification['kind'] =
    n.type === 'created' ? 'invited' : n.type === 'destroyed' ? 'cancelled' : 'changed'
  if (kind === 'changed' && email) {
    const participants = patch['participants']
    if (participants && typeof participants === 'object') {
      for (const p of Object.values(participants as Record<string, JmapParticipant>)) {
        if (addressOf(p?.calendarAddress).toLowerCase() !== email.toLowerCase()) continue
        const status = p.participationStatus
        if (status && status in RSVP_KINDS) kind = RSVP_KINDS[status as keyof typeof RSVP_KINDS]
      }
    }
  }
  return {
    id: n.id,
    created: n.created ?? '',
    kind,
    by: (n.changedBy?.name ?? '').trim() || email,
    byEmail: email,
    eventId: n.calendarEventId ?? null,
    title: typeof patch['title'] === 'string' ? patch['title'] : '',
    comment: n.comment ?? '',
  }
}

function toCalendar(c: JmapCalendar): Calendar {
  return {
    id: c.id,
    name: c.name,
    color: c.color ?? null,
    isDefault: c.isDefault ?? false,
    mayWrite: c.myRights?.mayWriteAll ?? c.myRights?.mayWriteOwn ?? true,
    mayDelete: c.myRights?.mayDelete ?? true,
  }
}

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly'])

const STATUSES = new Set(['needs-action', 'accepted', 'declined', 'tentative'])

const addressOf = (a: string | null | undefined) => (a ?? '').replace(/^mailto:/i, '')

function toParticipants(e: JmapCalendarEvent): Participant[] {
  const organizer = addressOf(e.organizerCalendarAddress).toLowerCase()
  // Stalwart mirrors the ORGANIZER into a second, roleless participant entry
  // alongside the one we sent, so the same address can appear twice. Keep the
  // entry that actually carries roles — it is the one RSVP patches must target.
  const byAddress = new Map<string, Participant>()
  for (const [id, p] of Object.entries(e.participants ?? {})) {
    const email = addressOf(p.calendarAddress)
    if (!email) continue
    const key = email.toLowerCase()
    const roles = p.roles ?? {}
    const hasRoles = Object.keys(roles).length > 0
    if (byAddress.has(key) && !hasRoles) continue
    const status = p.participationStatus ?? ''
    byAddress.set(key, {
      id,
      email,
      name: p.name ?? '',
      isOrganizer: roles['owner'] === true || key === organizer,
      // Stalwart writes `required`/`optional`; plain `attendee` means required.
      required: roles['optional'] !== true,
      status: (STATUSES.has(status) ? status : 'needs-action') as ParticipationStatus,
      expectReply: p.expectReply ?? false,
    })
  }
  return [...byAddress.values()]
}

/**
 * `roles.owner` alone is not enough: without `organizerCalendarAddress`
 * Stalwart stores the participants but writes no ORGANIZER, and then sends no
 * invitations at all. Sending it costs a duplicate organizer entry on read,
 * which toParticipants folds back together.
 */
function fromParticipants(ps: Participant[]): Record<string, unknown> | undefined {
  if (!ps.length) return undefined
  const out: Record<string, unknown> = {}
  for (const p of ps) {
    out[p.id] = {
      '@type': 'Participant',
      name: p.name || undefined,
      calendarAddress: `mailto:${p.email}`,
      roles: p.isOrganizer
        ? { owner: true, chair: true, required: true }
        : p.required
          ? { required: true }
          : { optional: true },
      participationStatus: p.status,
      expectReply: p.expectReply,
    }
  }
  return out
}

/**
 * The per-occurrence patches, kept whole.
 *
 * Only the shape is checked — a map of objects — and nothing inside is read or
 * dropped here: mel writes the whole map back on the next save, so a field it
 * did not keep is a field it would delete on somebody else's behalf.
 */
function toOverrides(
  raw: Record<string, Record<string, unknown>> | null | undefined,
): Record<string, RecurrencePatch> {
  const out: Record<string, RecurrencePatch> = {}
  for (const [id, patch] of Object.entries(raw ?? {})) {
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) out[id] = patch
  }
  return out
}

export function toEvent(e: JmapCalendarEvent): CalendarEvent {
  const calendarIds: Record<string, true> = {}
  for (const [id, on] of Object.entries(e.calendarIds ?? {})) if (on) calendarIds[id] = true
  let rule: RecurrenceRule | null = null
  if (e.recurrenceRule && FREQUENCIES.has(e.recurrenceRule.frequency)) {
    rule = {
      frequency: e.recurrenceRule.frequency as RecurrenceRule['frequency'],
      interval: e.recurrenceRule.interval,
      count: e.recurrenceRule.count,
      until: e.recurrenceRule.until,
      byDay: e.recurrenceRule.byDay?.map((d) => d.day),
      byMonthDay: e.recurrenceRule.byMonthDay,
    }
  }
  return {
    id: e.id,
    calendarIds,
    uid: e.uid ?? '',
    title: e.title ?? '',
    description: e.description ?? '',
    location: Object.values(e.locations ?? {})[0]?.name ?? '',
    meetingUrl: Object.values(e.virtualLocations ?? {})[0]?.uri ?? '',
    freeBusyStatus: e.freeBusyStatus === 'free' ? 'free' : 'busy',
    privacy: e.privacy === 'private' || e.privacy === 'secret' ? e.privacy : 'public',
    categories: Object.entries(e.categories ?? {})
      .filter(([, on]) => on)
      .map(([name]) => name),
    start: e.start ?? '',
    timeZone: e.timeZone ?? null,
    duration: e.duration ?? 'PT0S',
    showWithoutTime: e.showWithoutTime ?? false,
    status: e.status === 'cancelled' || e.status === 'tentative' ? e.status : 'confirmed',
    recurrenceRule: rule,
    recurrenceOverrides: toOverrides(e.recurrenceOverrides),
    alerts: toAlerts(e.alerts),
    links: toLinks(e.links),
    participants: toParticipants(e),
    isOrganizerCopy: e.isOrigin ?? true,
  }
}

function organizerAddress(ps: Participant[]): string | undefined {
  const organizer = ps.find((p) => p.isOrganizer)
  return organizer ? `mailto:${organizer.email}` : undefined
}

export function fromEvent(ev: CalendarEvent): Record<string, unknown> {
  return {
    '@type': 'Event',
    calendarIds: ev.calendarIds,
    uid: ev.uid || crypto.randomUUID(),
    title: ev.title,
    description: ev.description || undefined,
    locations: ev.location ? { l0: { '@type': 'Location', name: ev.location } } : undefined,
    // Left out at their defaults, like the rest: the server reads absent as busy / public.
    freeBusyStatus: ev.freeBusyStatus === 'free' ? 'free' : undefined,
    privacy: ev.privacy === 'private' || ev.privacy === 'secret' ? ev.privacy : undefined,
    categories: ev.categories?.length
      ? Object.fromEntries(ev.categories.map((name) => [name, true]))
      : undefined,
    virtualLocations: ev.meetingUrl
      ? { v0: { '@type': 'VirtualLocation', name: 'Meeting', uri: ev.meetingUrl } }
      : undefined,
    start: ev.start,
    timeZone: ev.showWithoutTime ? undefined : (ev.timeZone ?? undefined),
    duration: ev.duration,
    showWithoutTime: ev.showWithoutTime || undefined,
    status: ev.status !== 'confirmed' ? ev.status : undefined,
    recurrenceRule: ev.recurrenceRule
      ? {
          frequency: ev.recurrenceRule.frequency,
          interval: ev.recurrenceRule.interval,
          count: ev.recurrenceRule.count,
          until: ev.recurrenceRule.until,
          byDay: ev.recurrenceRule.byDay?.map((d) => ({ day: d })),
          byMonthDay: ev.recurrenceRule.byMonthDay,
        }
      : undefined,
    // Explicitly null when there are none: leaving the property out would keep
    // whatever the server still has, and then an occurrence put back into the
    // series — an undone delete — would stay excluded.
    recurrenceOverrides: Object.keys(ev.recurrenceOverrides ?? {}).length
      ? ev.recurrenceOverrides
      : null,
    /*
     * Null when the last reminder was removed, so that it reaches a server that
     * still has it — but absent when this copy never read any (a row synced
     * before alerts were kept): there "none" means "unknown", and clearing
     * would delete reminders another client set.
     */
    alerts: ev.alerts === undefined ? undefined : Object.keys(ev.alerts).length ? ev.alerts : null,
    // As with alerts: null for a known-empty map, absent for a row that never read one.
    links: ev.links === undefined ? undefined : Object.keys(ev.links).length ? ev.links : null,
    participants: fromParticipants(ev.participants),
    organizerCalendarAddress: organizerAddress(ev.participants),
  }
}

export function createJmapCalendars(transport: Transport, accountId: string): CalendarProvider {
  const batch = () => new Batch(transport, USING)

  return {
    syncCalendars(sinceState) {
      return syncCollection<JmapCalendar, Calendar>(
        batch,
        { type: 'Calendar', accountId, map: toCalendar },
        sinceState,
      )
    },
    syncEvents(sinceState) {
      return syncCollection<JmapCalendarEvent, CalendarEvent>(
        batch,
        { type: 'CalendarEvent', accountId, map: toEvent },
        sinceState,
      )
    },

    async createEvent(event) {
      const b = batch()
      const s = b.call<SetResponse<{ id: string }>>('CalendarEvent/set', {
        accountId,
        // Without this the event is stored but no invitations ever go out.
        sendSchedulingMessages: event.participants.length > 0,
        create: { e0: fromEvent(event) },
      })
      await b.send()
      const created = s.result.created?.['e0']
      if (created) return { id: created.id, failure: null }
      return { id: null, failure: toFailure(s.result.notCreated?.['e0']) }
    },

    async updateEvent(event) {
      // In RFC 8984 / JMAP Calendars, uid is immutable and cannot be changed on update.
      const { uid: _uid, ...patch } = fromEvent(event)
      /*
       * A cleared field is absent from `fromEvent` (create must not send nulls),
       * and an absent key in an update keeps what the server has — so an
       * emptied location would come back on the next sync. Say null instead.
       * `meetingUrl` is only cleared when known to be empty: undefined means
       * this row never read it.
       */
      if (!event.description) patch['description'] = null
      if (!event.location) patch['locations'] = null
      if (event.meetingUrl === '') patch['virtualLocations'] = null
      // The same for the three that are only known once this copy has read them.
      if (event.freeBusyStatus === 'busy') patch['freeBusyStatus'] = null
      if (event.privacy === 'public') patch['privacy'] = null
      if (event.categories?.length === 0) patch['categories'] = null
      const b = batch()
      const s = b.call<SetResponse<unknown>>('CalendarEvent/set', {
        accountId,
        sendSchedulingMessages: event.participants.length > 0,
        update: { [event.id]: patch },
      })
      await b.send()
      const err = s.result.notUpdated?.[event.id]
      return err ? toFailure(err) : null
    },

    async rsvp(eventId, participantId, status) {
      // A patch, so we touch only our own reply and never clobber concurrent
      // organizer edits to the rest of the event.
      const b = batch()
      const s = b.call<SetResponse<unknown>>('CalendarEvent/set', {
        accountId,
        sendSchedulingMessages: true,
        update: { [eventId]: { [`participants/${participantId}/participationStatus`]: status } },
      })
      await b.send()
      const err = s.result.notUpdated?.[eventId]
      return err ? toFailure(err) : null
    },

    async syncEventNotifications(sinceState) {
      try {
        return await syncCollection<JmapEventNotification, EventNotification>(
          batch,
          {
            type: 'CalendarEventNotification',
            accountId,
            // Asked for by name: Stalwart leaves the event id, the comment and the
            // patch out of a plain get, and the patch is what says an RSVP happened.
            properties: [
              'id',
              'created',
              'changedBy',
              'comment',
              'type',
              'calendarEventId',
              'eventPatch',
            ],
            map: toNotification,
          },
          sinceState,
        )
      } catch (e) {
        // A server that has calendars but not their notifications must not take
        // the calendar sync down with it: report an empty, settled collection.
        if (e instanceof JmapError && e.message.includes('unknownMethod')) {
          return {
            created: [],
            updated: [],
            destroyedIds: [],
            newState: 'unsupported',
            hasMore: false,
          }
        }
        throw e
      }
    },

    async dismissEventNotifications(ids) {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('CalendarEventNotification/set', {
        accountId,
        destroy: ids,
      })
      await b.send()
      const errs = Object.values(s.result.notDestroyed ?? {})
      return errs.length ? toFailure(errs[0]) : null
    },

    async editCalendar(edit) {
      const b = batch()
      const s = b.call<SetResponse<{ id: string }>>('Calendar/set', {
        accountId,
        // Subscribed, or Stalwart creates it hidden from the account's own list.
        create: edit.create ? { c0: { ...edit.create, isSubscribed: true } } : undefined,
        update: edit.update ? { [edit.update.id]: { ...edit.update, id: undefined } } : undefined,
        destroy: edit.destroy ? [edit.destroy] : undefined,
        onDestroyRemoveEvents: edit.destroy ? (edit.destroyWithEvents ?? false) : undefined,
      })
      await b.send()
      if (edit.create) {
        const created = s.result.created?.['c0']
        return created
          ? { id: created.id, failure: null }
          : { id: null, failure: toFailure(s.result.notCreated?.['c0']) }
      }
      const key = edit.update?.id ?? edit.destroy ?? ''
      const err = s.result.notUpdated?.[key] ?? s.result.notDestroyed?.[key]
      return { id: key, failure: err ? toFailure(err) : null }
    },

    async destroyEvents(ids) {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('CalendarEvent/set', {
        accountId,
        // Tells attendees the meeting is off instead of silently vanishing.
        sendSchedulingMessages: true,
        destroy: ids,
      })
      await b.send()
      const errs = Object.values(s.result.notDestroyed ?? {})
      return errs.length ? toFailure(errs[0]) : null
    },
  }
}
