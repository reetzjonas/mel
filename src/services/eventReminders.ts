import { liveQuery } from 'dexie'
import type { CalendarEvent } from '../domain/calendar'
import { useUi } from '../app/store'
import { pendingAlerts, type PendingAlert } from '../lib/alerts'
import { readHiddenCalendars } from '../lib/hiddenCalendars'
import { currentLocale, t } from '../lib/i18n'
import { db } from '../storage/db'
import { openEnvelope } from '../storage/envelope'

/*
 * Reminders for calendar events, shown while mel is running.
 *
 * There is no server of ours to wake a closed browser, and the one API meant
 * for it (notification triggers) was withdrawn, so a reminder is only shown by
 * a page that is open. What makes that less bad is the catch-up: an alert whose
 * moment passed while the app was closed or the machine asleep is shown when
 * mel next runs, provided the event has not ended (see pendingAlerts).
 * docs/notes/calendar-alerts.md has the reasoning.
 */

/** How far ahead alerts are planned; the plan is redone as time passes. */
const HORIZON_MS = 36 * 3_600_000
/** Never sleep longer than this: a timer does not count time spent suspended. */
const MAX_WAIT_MS = 15 * 60_000
/** More than this at once is a backlog after a long absence, not a set of reminders. */
const MAX_SHOWN = 5

const firedKey = (accountId: string) => `mel:reminded:${accountId}`

/** Which alerts were already shown, by key, with the moment they fell due. */
export function readFired(accountId: string): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(firedKey(accountId)) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeFired(accountId: string, fired: Record<string, number>, now: number): void {
  // What fell due more than two days ago cannot come back: it would have to
  // be about an event still running, and none is that long.
  const kept = Object.fromEntries(
    Object.entries(fired).filter(([, at]) => at > now - 2 * 86_400_000),
  )
  try {
    localStorage.setItem(firedKey(accountId), JSON.stringify(kept))
  } catch {
    // Storage full or blocked: worst case a reminder shows twice.
  }
}

const relative = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' })
const clock = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })

/** "in 15 minutes · 10:00 · Room 4" */
export function describeAlert(alert: PendingAlert, now: Date): { title: string; body: string } {
  const minutes = Math.round((alert.start.getTime() - now.getTime()) / 60_000)
  const lead =
    Math.abs(minutes) >= 1440
      ? relative.format(Math.round(minutes / 1440), 'day')
      : Math.abs(minutes) >= 60
        ? relative.format(Math.round(minutes / 60), 'hour')
        : relative.format(minutes, 'minute')
  const parts = [lead, alert.allDay ? t('cal.allDay') : clock.format(alert.start)]
  if (alert.location) parts.push(alert.location)
  return { title: alert.title || t('cal.untitled'), body: parts.join(' · ') }
}

/**
 * Shows the alerts that are due, and says when to look again.
 *
 * `deliver` returns whether the alert was shown. One that was not — no
 * permission and nobody looking at the page — stays unmarked and is tried
 * again the next time this runs, which is when the tab comes back to the front.
 */
export function runReminders(
  events: CalendarEvent[],
  now: Date,
  fired: Record<string, number>,
  viewerZone: string,
  deliver: (alerts: PendingAlert[], now: Date) => boolean,
): { fired: Record<string, number>; nextAt: Date | null } {
  const pending = pendingAlerts(events, now, HORIZON_MS, viewerZone).filter(
    (a) => !(a.key in fired),
  )
  const due = pending.filter((a) => a.fireAt <= now)
  const nextAt = pending.find((a) => a.fireAt > now)?.fireAt ?? null
  if (!due.length || !deliver(due, now)) return { fired, nextAt }
  const marked = { ...fired }
  for (const a of due) marked[a.key] = a.fireAt.getTime()
  return { fired: marked, nextAt }
}

function showSystemNotification(alerts: PendingAlert[], now: Date): void {
  for (const alert of alerts.slice(0, MAX_SHOWN)) {
    const { title, body } = describeAlert(alert, now)
    const options: NotificationOptions = {
      body,
      tag: `mel-reminder-${alert.key}`,
      icon: '/icon.svg',
      data: { url: '/calendar' },
    }
    void (async () => {
      // Android Chrome refuses `new Notification`; only a registration may show one.
      const registration = await navigator.serviceWorker?.getRegistration()
      if (registration) await registration.showNotification(title, options)
      else new Notification(title, options)
    })().catch(() => {})
  }
}

/** Returns whether anything was shown. */
export function deliverReminders(alerts: PendingAlert[], now: Date): boolean {
  if ('Notification' in window && Notification.permission === 'granted') {
    showSystemNotification(alerts, now)
    return true
  }
  // Without permission the only way to be seen is in the page, so only when it is looked at.
  if (document.hidden) return false
  const message = alerts
    .slice(0, MAX_SHOWN)
    .map((a) => {
      const { title, body } = describeAlert(a, now)
      return `${title} — ${body.split(' · ')[0]}`
    })
    .join('; ')
  useUi.getState().showSnackbar({ message })
  return true
}

const running = new Map<string, () => void>()

/**
 * Starts showing reminders for an account's events; returns the stopper.
 * Idempotent per account, like the sync scheduler beside it.
 */
export function startEventReminders(accountId: string): () => void {
  const existing = running.get(accountId)
  if (existing) return existing

  let events: CalendarEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const plan = () => {
    if (timer) clearTimeout(timer)
    if (stopped) return
    const now = new Date()
    const hidden = new Set(readHiddenCalendars(accountId))
    // A calendar switched off in the sidebar is one the person does not want in front of them.
    const visible = events.filter((e) => Object.keys(e.calendarIds).some((id) => !hidden.has(id)))
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const fired = readFired(accountId)
    const result = runReminders(visible, now, fired, zone, deliverReminders)
    if (result.fired !== fired) writeFired(accountId, result.fired, now.getTime())
    const wait = result.nextAt ? result.nextAt.getTime() - now.getTime() : MAX_WAIT_MS
    timer = setTimeout(plan, Math.max(1_000, Math.min(wait, MAX_WAIT_MS)))
  }

  const subscription = liveQuery(async () => {
    const rows = await db.events.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload))
  }).subscribe({
    next: (list) => {
      events = list
      plan()
    },
    error: () => {},
  })

  const onVisible = () => {
    if (!document.hidden) plan()
  }
  document.addEventListener('visibilitychange', onVisible)

  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    subscription.unsubscribe()
    document.removeEventListener('visibilitychange', onVisible)
    running.delete(accountId)
  }
  running.set(accountId, stop)
  return stop
}
