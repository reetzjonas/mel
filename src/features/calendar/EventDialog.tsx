import { useRef, useState, type ReactNode } from 'react'
import { Temporal } from 'temporal-polyfill'
import type {
  Calendar,
  CalendarEvent,
  Participant,
  ParticipationStatus,
} from '../../domain/calendar'
import { REMINDER_PRESETS, reminderOf, withReminder } from '../../lib/alerts'
import { t, type MsgKey } from '../../lib/i18n'
import { followStartDay, formOf, repeatError, ruleOf, sameForm } from '../../lib/recurrenceForm'
import { requestNotificationPermission } from '../../services/notifications'
import { DialogHeader } from '../../ui/DialogHeader'
import { Select } from '../../ui/Select'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'
import { useMobileViewport, useModal } from '../../ui/useModal'
import { ParticipantsField, ParticipantStatusBadge } from './ParticipantsField'
import { RecurrenceField } from './RecurrenceField'

const RSVP_CHOICES = [
  ['accepted', 'cal.rsvp.accept'],
  ['tentative', 'cal.rsvp.maybe'],
  ['declined', 'cal.rsvp.decline'],
] as const satisfies ReadonlyArray<readonly [ParticipationStatus, MsgKey]>

const REMINDER_LABELS: Record<number, MsgKey> = {
  0: 'cal.reminder.m0',
  5: 'cal.reminder.m5',
  10: 'cal.reminder.m10',
  15: 'cal.reminder.m15',
  30: 'cal.reminder.m30',
  60: 'cal.reminder.m60',
  120: 'cal.reminder.m120',
  1440: 'cal.reminder.m1440',
  2880: 'cal.reminder.m2880',
}

/** The presets, plus the event's own value when another client set one that is not among them. */
function reminderChoices(current: number | null): Array<[number, string]> {
  const minutes =
    current !== null && !(current in REMINDER_LABELS)
      ? [...REMINDER_PRESETS, current]
      : REMINDER_PRESETS
  return [...minutes]
    .sort((a, b) => a - b)
    .map((m) => [
      m,
      REMINDER_LABELS[m]
        ? t(REMINDER_LABELS[m])
        : `${t('cal.reminder.custom')}: ${m} ${t('cal.min')}`,
    ])
}

function partsOf(start: string, duration: string) {
  const value = Temporal.PlainDateTime.from(start)
  const end = value.add(Temporal.Duration.from(duration || 'PT1H'))
  return {
    date: value.toPlainDate().toString(),
    time: value.toPlainTime().toString({ smallestUnit: 'minute' }),
    endDate: end.toPlainDate().toString(),
    endTime: end.toPlainTime().toString({ smallestUnit: 'minute' }),
  }
}

function durationBetween(start: string, end: string, allDay: boolean) {
  const from = Temporal.PlainDateTime.from(start)
  const to = Temporal.PlainDateTime.from(end)
  if (Temporal.PlainDateTime.compare(to, from) <= 0) return null
  return from.until(to, { largestUnit: allDay ? 'day' : 'hour', smallestUnit: 'minute' }).toString()
}

export function EventDialog({
  initial,
  calendars,
  accountId,
  self,
  occurrence = false,
  onSave,
  onDelete,
  onRsvp,
  onClose,
}: {
  initial: CalendarEvent
  /** Omit or pass a single-item list to hide the calendar picker. */
  calendars?: Calendar[]
  accountId: string
  /** The address we invite people as, and the one we RSVP with. */
  self: { name: string; email: string }
  /** True when this is one occurrence of a series rather than the series. */
  occurrence?: boolean
  onSave: (e: CalendarEvent) => void
  onDelete: (() => void) | null
  onRsvp: (status: ParticipationStatus) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [calendarId, setCalendarId] = useState(
    Object.keys(initial.calendarIds)[0] ?? calendars?.[0]?.id ?? '',
  )
  const initialParts = partsOf(initial.start, initial.duration)
  const [date, setDate] = useState(initialParts.date)
  const [time, setTime] = useState(initialParts.time)
  const [endDate, setEndDate] = useState(initialParts.endDate)
  const [endTime, setEndTime] = useState(initialParts.endTime)
  const [allDay, setAllDay] = useState(initial.showWithoutTime)
  const [location, setLocation] = useState(initial.location)
  const [description, setDescription] = useState(initial.description)
  const initialRepeat = formOf(initial.recurrenceRule, initialParts.date)
  const [repeat, setRepeat] = useState(initialRepeat)
  const [participants, setParticipants] = useState<Participant[]>(initial.participants)
  const initialReminder = reminderOf(initial.alerts ?? {})?.minutes ?? null
  const [reminder, setReminder] = useState<number | null>(initialReminder)
  const [showDetails, setShowDetails] = useState(
    Boolean(
      initial.location || initial.description || initial.recurrenceRule || initialReminder !== null,
    ),
  )
  const panel = useRef<HTMLDivElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, onClose })

  // On an invitation the organizer owns the event; we may only answer it.
  const me = initial.participants.find(
    (p) => !p.isOrganizer && p.email.toLowerCase() === self.email.trim().toLowerCase(),
  )

  function save() {
    if (!title.trim() || !date || repeatError(repeat, date)) return
    const start = allDay ? `${date}T00:00:00` : `${date}T${time}:00`
    const end = allDay ? `${endDate}T00:00:00` : `${endDate}T${endTime}:00`
    const duration = durationBetween(start, end, allDay)
    if (!duration) return
    onSave({
      ...initial,
      calendarIds: calendarId ? { [calendarId]: true } : initial.calendarIds,
      title: title.trim(),
      start,
      duration,
      showWithoutTime: allDay,
      location: location.trim(),
      description: description.trim(),
      // Untouched controls keep the rule as the server has it, including what
      // they cannot show (a `byMonthDay`, an `until` with a time of day).
      recurrenceRule: sameForm(initialRepeat, repeat)
        ? initial.recurrenceRule
        : ruleOf(repeat, date, initial.recurrenceRule),
      participants,
      // Left as it was unless changed: an event whose alerts were never read
      // must not be handed an empty map that then overwrites the server's.
      alerts:
        reminder === initialReminder
          ? initial.alerts
          : withReminder(initial.alerts ?? {}, reminder),
    })
  }

  function toggleAllDay(next: boolean) {
    setAllDay(next)
    if (next && endDate <= date)
      setEndDate(Temporal.PlainDate.from(date).add({ days: 1 }).toString())
    if (!next && time === '00:00' && endTime === '00:00') {
      setTime('10:00')
      setEndTime('11:00')
    }
  }

  function changeStartDate(next: string) {
    const shift = Temporal.PlainDate.from(date).until(Temporal.PlainDate.from(next), {
      largestUnit: 'day',
    }).days
    setDate(next)
    setEndDate(Temporal.PlainDate.from(endDate).add({ days: shift }).toString())
    setRepeat((form) => followStartDay(form, date, next))
  }

  function changeStartTime(next: string) {
    const duration = durationBetween(`${date}T${time}:00`, `${endDate}T${endTime}:00`, false)
    setTime(next)
    if (!duration) return
    // Start-date edits already retain the duration. Do the same for the time,
    // so changing a new event from its default morning slot cannot leave Save
    // disabled because its untouched end time is now in the past.
    const end = Temporal.PlainDateTime.from(`${date}T${next}:00`).add(
      Temporal.Duration.from(duration),
    )
    setEndDate(end.toPlainDate().toString())
    setEndTime(end.toPlainTime().toString({ smallestUnit: 'minute' }))
  }

  const start = allDay ? `${date}T00:00:00` : `${date}T${time}:00`
  const end = allDay ? `${endDate}T00:00:00` : `${endDate}T${endTime}:00`
  const invalidEnd = !durationBetween(start, end, allDay)
  const invalidRepeat = repeatError(repeat, date) !== null

  const shell = (children: ReactNode) => (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={initial.id ? t('cal.editEvent') : t('cal.newEvent')}
        className="animate-rise flex max-h-[92dvh] w-full flex-col overflow-hidden bg-raised max-sm:rounded-t-panel sm:max-w-lg sm:rounded-panel sm:shadow-overlay sm:ring-1 sm:ring-line"
        style={mobileViewport ? { maxHeight: `${mobileViewport.height - 16}px` } : undefined}
      >
        {children}
      </div>
    </div>
  )

  // On an invitation we may only answer, never edit.
  if (me && !initial.isOrganizerCopy) {
    const organizer = initial.participants.find((p) => p.isOrganizer)
    const when = initial.showWithoutTime
      ? initial.start.slice(0, 10)
      : `${initial.start.slice(0, 10)} ${initial.start.slice(11, 16)}`
    return shell(
      <>
        <DialogHeader title={t('cal.invitation')} closeLabel={t('cal.close')} onClose={onClose} />
        <div className="space-y-3 overflow-y-auto p-5">
          <p className="text-lg font-medium">{initial.title}</p>
          <dl className="space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-ink-muted">{t('cal.when')}</dt>
              <dd>{when}</dd>
            </div>
            {initial.location && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-ink-muted">{t('cal.location')}</dt>
                <dd>{initial.location}</dd>
              </div>
            )}
            {organizer && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-ink-muted">{t('cal.organizer')}</dt>
                <dd>{organizer.name || organizer.email}</dd>
              </div>
            )}
          </dl>
          {initial.description && (
            <p className="text-sm whitespace-pre-wrap text-ink-muted">{initial.description}</p>
          )}
          <div className="space-y-1">
            <span className="text-xs text-ink-muted">{t('cal.attendees')}</span>
            <ul className="space-y-0.5">
              {initial.participants
                .filter((p) => !p.isOrganizer)
                .map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-2 py-1 text-sm">
                    <span className="min-w-0 flex-1 truncate">{p.name || p.email}</span>
                    <ParticipantStatusBadge status={p.status} />
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <span className="text-xs text-ink-muted">{t('cal.yourReply')}</span>
            <div className="mt-1 flex flex-wrap gap-2">
              {RSVP_CHOICES.map(([status, label]) => (
                <button
                  key={status}
                  type="button"
                  aria-pressed={me.status === status}
                  onClick={() => onRsvp(status)}
                  className={me.status === status ? primaryButtonClass : secondaryButtonClass}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </>,
    )
  }

  return shell(
    <>
      <DialogHeader
        title={initial.id ? t('cal.editEvent') : t('cal.newEvent')}
        closeLabel={t('cal.cancel')}
        onClose={onClose}
        action={
          <button
            type="button"
            onClick={save}
            disabled={!title.trim() || invalidEnd || invalidRepeat}
            className="text-sm font-semibold text-ink-muted hover:text-accent disabled:text-ink-subtle"
          >
            {participants.length > 0 ? t('cal.saveAndInvite') : t('cal.save')}
          </button>
        }
      />
      <div className="space-y-5 overflow-y-auto px-4 py-5 sm:px-5">
        <div className="space-y-2">
          <input
            className="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-ink-subtle"
            placeholder={t('cal.title')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          {calendars && calendars.length > 1 && (
            <Select
              aria-label={t('cal.calendar')}
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              controlClassName="border-0 bg-transparent px-0 py-1.5 text-ink-muted focus:ring-0"
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <section className="space-y-3 rounded-panel bg-surface-2 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{t('cal.when')}</h3>
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => toggleAllDay(e.target.checked)}
              />
              {t('cal.allDay')}
            </label>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
            <label className="space-y-1">
              <span className="text-xs text-ink-muted">{t('cal.startDate')}</span>
              <input
                className={inputClass}
                type="date"
                value={date}
                onChange={(e) => changeStartDate(e.target.value)}
              />
            </label>
            {!allDay && (
              <label className="space-y-1">
                <span className="text-xs text-ink-muted">{t('cal.startTime')}</span>
                <input
                  className={inputClass}
                  type="time"
                  value={time}
                  onChange={(e) => changeStartTime(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
            <label className="space-y-1">
              <span className="text-xs text-ink-muted">{t('cal.endDate')}</span>
              <input
                className={inputClass}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>
            {!allDay && (
              <label className="space-y-1">
                <span className="text-xs text-ink-muted">{t('cal.endTime')}</span>
                <input
                  className={inputClass}
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </label>
            )}
          </div>
          {invalidEnd && <p className="text-xs text-danger">{t('cal.invalidEnd')}</p>}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('cal.attendees')}</h3>
          <ParticipantsField
            value={participants}
            onChange={setParticipants}
            accountId={accountId}
            self={self}
          />
        </section>

        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowDetails((shown) => !shown)}
            aria-expanded={showDetails}
            className="text-sm font-medium text-ink-muted hover:text-ink"
          >
            {showDetails ? t('cal.hideDetails') : t('cal.moreDetails')}
          </button>
          {showDetails && (
            <div className="space-y-4">
              <RecurrenceField value={repeat} startDate={date} onChange={setRepeat} />
              {!occurrence && (
                <label className="space-y-1">
                  <span className="text-xs text-ink-muted">{t('cal.reminder')}</span>
                  <Select
                    value={reminder === null ? 'none' : String(reminder)}
                    onChange={(e) => {
                      const next = e.target.value === 'none' ? null : Number(e.target.value)
                      setReminder(next)
                      if (
                        next !== null &&
                        'Notification' in window &&
                        Notification.permission === 'default'
                      )
                        void requestNotificationPermission()
                    }}
                  >
                    <option value="none">{t('cal.reminder.none')}</option>
                    {reminderChoices(initialReminder).map(([m, label]) => (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {occurrence && <p className="text-xs text-ink-muted">{t('cal.scope.hint')}</p>}
              <div className="space-y-3 pt-3">
                <input
                  className={inputClass}
                  placeholder={t('cal.location')}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
                <textarea
                  className={`${inputClass} min-h-20`}
                  placeholder={t('cal.descriptionField')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          )}
        </section>

        {onDelete && (
          <button type="button" onClick={onDelete} className="text-sm text-danger hover:underline">
            {t('cal.delete')}
          </button>
        )}
      </div>
    </>,
  )
}
