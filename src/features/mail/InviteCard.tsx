import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Temporal } from 'temporal-polyfill'
import { useUi } from '../../app/store'
import type { EmailBodyPart } from '../../domain/email'
import { useCalendars, useEvents } from '../calendar/hooks'
import { currentLocale, t } from '../../lib/i18n'
import { parseIcs, type IcsEvent, type IcsInvitation } from '../../lib/icalendar'
import { parseDuration } from '../../lib/recurrence'
import { getAttachmentText } from '../../services/mail'
import { createEvent } from '../../services/calendar'
import { Icon } from '../../ui/Icon'
import { inputClass, primaryButtonClass } from '../../ui/styles'

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const dayFmt = new Intl.DateTimeFormat(currentLocale, {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const dateTimeFmt = new Intl.DateTimeFormat(currentLocale, {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
})
const timeFmt = new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' })

/** A date-only value shown as the day it names, wherever the reader is. */
function plainDay(date: Temporal.PlainDate): Date {
  return new Date(date.year, date.month - 1, date.day)
}

function formatWhen(event: IcsEvent): string {
  if (event.showWithoutTime) {
    const start = Temporal.PlainDate.from(event.start.slice(0, 10))
    // The stored duration is exclusive; the last day a reader cares about is
    // the one before it ends.
    const days = Math.max(1, Math.round(parseDuration(event.duration).total({ unit: 'hour' }) / 24))
    return days > 1
      ? `${dayFmt.format(plainDay(start))} – ${dayFmt.format(plainDay(start.add({ days: days - 1 })))}`
      : dayFmt.format(plainDay(start))
  }
  const zoned = Temporal.PlainDateTime.from(event.start).toZonedDateTime(
    event.timeZone ?? VIEWER_ZONE,
  )
  const start = new Date(zoned.epochMilliseconds)
  const end = new Date(zoned.add(parseDuration(event.duration)).epochMilliseconds)
  return `${dateTimeFmt.format(start)} – ${timeFmt.format(end)}`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  )
}

/**
 * The event an .ics part describes, offered for the calendar of your choice.
 *
 * Separate from the RSVP flow in the calendar: that one answers invitations
 * the *server* already filed for us (iMIP), which only happens for scheduling
 * requests addressed to this account. Everything else that carries an .ics —
 * a forwarded invitation, a booking confirmation, a ticket, a mailing list
 * announcement — arrives as a plain attachment and would otherwise have to be
 * retyped by hand.
 */
export function InviteCard({ accountId, part }: { accountId: string; part: EmailBodyPart }) {
  const [invite, setInvite] = useState<IcsInvitation | null | 'loading'>('loading')
  const [calendarId, setCalendarId] = useState('')
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(false)
  const calendars = useCalendars(accountId)
  const events = useEvents(accountId)
  const { showSnackbar } = useUi()
  const blobId = part.blobId

  useEffect(() => {
    if (!blobId) return
    let alive = true
    setInvite('loading')
    setAdded(false)
    getAttachmentText(accountId, blobId, part.type, part.name ?? 'invite.ics')
      .then((text) => alive && setInvite(text ? parseIcs(text) : null))
      .catch(() => alive && setInvite(null))
    return () => {
      alive = false
    }
  }, [accountId, blobId, part.type, part.name])

  if (invite === 'loading') return null

  if (invite === null) {
    return (
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-muted lg:px-6">
        <Icon name="calendar" size={13} className="shrink-0" />
        {t('mail.invite.unreadable')}
      </div>
    )
  }

  const writable = (calendars ?? []).filter((c) => c.mayWrite)
  const selected = calendarId || writable.find((c) => c.isDefault)?.id || writable[0]?.id || ''
  /*
   * The same event may already be here — a scheduling request addressed to
   * this account is filed by the server before the message is even opened, so
   * offering to add it again would make a second copy of it.
   */
  const known = Boolean(invite.event.uid && events?.some((e) => e.uid === invite.event.uid))
  // A reply says how somebody answered; it is not an event to keep.
  const answerOnly = invite.method === 'REPLY'
  const organizer = invite.organizer

  async function add() {
    if (invite === 'loading' || invite === null || !selected) return
    setBusy(true)
    try {
      await createEvent(accountId, { ...invite.event, calendarIds: { [selected]: true } })
      setAdded(true)
      showSnackbar({ message: t('mail.invite.added') })
    } catch {
      showSnackbar({ message: t('mail.invite.failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border-b border-line bg-surface-2 px-4 py-3 lg:px-6">
      <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        <Icon name="calendar" size={13} className="shrink-0" />
        {t('mail.invite.heading')}
      </h3>
      <p className="mt-1.5 text-sm font-medium">
        {invite.event.title || t('mail.invite.untitled')}
      </p>
      <dl className="mt-1 space-y-0.5 text-xs">
        <Row label={t('cal.when')}>{formatWhen(invite.event)}</Row>
        {invite.event.location && <Row label={t('cal.location')}>{invite.event.location}</Row>}
        {organizer && <Row label={t('cal.organizer')}>{organizer.name || organizer.email}</Row>}
      </dl>
      {invite.method === 'CANCEL' && (
        <p className="mt-2 text-xs text-danger">{t('mail.invite.cancelled')}</p>
      )}
      {answerOnly ? (
        <p className="mt-2 text-xs text-ink-muted">{t('mail.invite.reply')}</p>
      ) : known || added ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
          <Icon name="check" size={13} className="shrink-0" />
          {added ? t('mail.invite.added') : t('mail.invite.exists')}
          <Link to="/calendar" className="font-medium text-accent hover:underline">
            {t('mail.invite.openCalendar')}
          </Link>
        </p>
      ) : writable.length === 0 ? (
        <p className="mt-2 text-xs text-ink-muted">{t('mail.invite.noCalendar')}</p>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {writable.length > 1 && (
            <select
              className={`${inputClass} w-auto max-w-56 py-1.5 text-xs`}
              aria-label={t('cal.calendar')}
              value={selected}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              {writable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={`${primaryButtonClass} px-3 py-1.5 text-xs`}
            disabled={busy}
            onClick={() => void add()}
          >
            {busy ? t('mail.invite.adding') : t('mail.invite.add')}
          </button>
        </div>
      )}
    </section>
  )
}
