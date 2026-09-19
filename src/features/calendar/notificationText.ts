import type { CalendarEvent, EventNotification } from '../../domain/calendar'
import { t, tf, type MsgKey } from '../../lib/i18n'

const SENTENCES: Record<EventNotification['kind'], MsgKey> = {
  invited: 'cal.notif.invited',
  accepted: 'cal.notif.accepted',
  declined: 'cal.notif.declined',
  tentative: 'cal.notif.tentative',
  changed: 'cal.notif.changed',
  cancelled: 'cal.notif.cancelled',
}

/** What a notification says, with the event's current title when we still have the event. */
export function notificationText(n: EventNotification, event: CalendarEvent | undefined): string {
  return tf(SENTENCES[n.kind], {
    name: n.by || t('cal.notif.someone'),
    title: event?.title || n.title || t('cal.untitled'),
  })
}
