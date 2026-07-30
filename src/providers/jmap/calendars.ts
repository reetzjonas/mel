import type { Calendar, CalendarEvent, RecurrenceRule } from '../../domain/calendar'
import {
  CannotCalculateChanges,
  type CalendarProvider,
  type SetFailure,
  type SyncPage,
} from '../types'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import { Cap, type ChangesResponse, type GetResponse, type SetError, type SetResponse } from './client/types/core'

const USING = [Cap.core, Cap.calendars]
const MAX_CHANGES = 256

const PERMANENT = new Set(['invalidProperties', 'invalidPatch', 'notFound', 'forbidden', 'overQuota'])

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

interface JmapCalendarEvent {
  id: string
  calendarIds: Record<string, boolean>
  uid?: string
  title?: string | null
  description?: string | null
  locations?: Record<string, { name?: string | null }> | null
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
    start: e.start ?? '',
    timeZone: e.timeZone ?? null,
    duration: e.duration ?? 'PT0S',
    showWithoutTime: e.showWithoutTime ?? false,
    status:
      e.status === 'cancelled' || e.status === 'tentative' ? e.status : 'confirmed',
    recurrenceRule: rule,
  }
}

export function fromEvent(ev: CalendarEvent): Record<string, unknown> {
  return {
    '@type': 'Event',
    calendarIds: ev.calendarIds,
    uid: ev.uid || crypto.randomUUID(),
    title: ev.title,
    description: ev.description || undefined,
    locations: ev.location ? { l0: { '@type': 'Location', name: ev.location } } : undefined,
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
  }
}

export function createJmapCalendars(transport: Transport, accountId: string): CalendarProvider {
  const batch = () => new Batch(transport, USING)

  async function sync<TJmap, TOut>(
    type: 'Calendar' | 'CalendarEvent',
    sinceState: string | undefined,
    map: (v: TJmap) => TOut,
  ): Promise<SyncPage<TOut>> {
    if (!sinceState) {
      const b = batch()
      const g = b.call<GetResponse<TJmap>>(`${type}/get`, { accountId, ids: null })
      await b.send()
      const r = g.result
      return { created: r.list.map(map), updated: [], destroyedIds: [], newState: r.state, hasMore: false }
    }
    const b = batch()
    const ch = b.call<ChangesResponse>(`${type}/changes`, { accountId, sinceState, maxChanges: MAX_CHANGES })
    const created = b.call<GetResponse<TJmap>>(`${type}/get`, { accountId, '#ids': ch.ref('/created') })
    const updated = b.call<GetResponse<TJmap>>(`${type}/get`, { accountId, '#ids': ch.ref('/updated') })
    await b.send()
    if (ch.error?.type === 'cannotCalculateChanges') throw new CannotCalculateChanges()
    const changes = ch.result
    return {
      created: created.result.list.map(map),
      updated: updated.result.list.map(map),
      destroyedIds: changes.destroyed,
      newState: changes.newState,
      hasMore: changes.hasMoreChanges,
    }
  }

  return {
    syncCalendars(sinceState) {
      return sync<JmapCalendar, Calendar>('Calendar', sinceState, toCalendar)
    },
    syncEvents(sinceState) {
      return sync<JmapCalendarEvent, CalendarEvent>('CalendarEvent', sinceState, toEvent)
    },

    async createEvent(event) {
      const b = batch()
      const s = b.call<SetResponse<{ id: string }>>('CalendarEvent/set', {
        accountId,
        create: { e0: fromEvent(event) },
      })
      await b.send()
      const created = s.result.created?.['e0']
      if (created) return { id: created.id, failure: null }
      return { id: null, failure: toFailure(s.result.notCreated?.['e0']) }
    },

    async updateEvent(event) {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('CalendarEvent/set', {
        accountId,
        update: { [event.id]: fromEvent(event) },
      })
      await b.send()
      const err = s.result.notUpdated?.[event.id]
      return err ? toFailure(err) : null
    },

    async destroyEvents(ids) {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('CalendarEvent/set', { accountId, destroy: ids })
      await b.send()
      const errs = Object.values(s.result.notDestroyed ?? {})
      return errs.length ? toFailure(errs[0]) : null
    },
  }
}
