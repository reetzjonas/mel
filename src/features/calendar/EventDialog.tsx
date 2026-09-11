import { useState, type ReactNode } from 'react'
import type {
  Calendar,
  CalendarEvent,
  Participant,
  ParticipationStatus,
  RecurrenceRule,
} from '../../domain/calendar'
import { t, type MsgKey } from '../../lib/i18n'
import { Select } from '../../ui/Select'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '../../ui/styles'
import { ParticipantsField, ParticipantStatusBadge } from './ParticipantsField'

const DURATIONS = [
  ['PT30M', `30 ${t('cal.min')}`],
  ['PT1H', `1 ${t('cal.hour')}`],
  ['PT1H30M', `1,5 ${t('cal.hour')}`],
  ['PT2H', `2 ${t('cal.hour')}`],
  ['PT4H', `4 ${t('cal.hour')}`],
  ['PT8H', `8 ${t('cal.hour')}`],
] as const

const RSVP_CHOICES = [
  ['accepted', 'cal.rsvp.accept'],
  ['tentative', 'cal.rsvp.maybe'],
  ['declined', 'cal.rsvp.decline'],
] as const satisfies ReadonlyArray<readonly [ParticipationStatus, MsgKey]>

type RepeatPreset = 'none' | RecurrenceRule['frequency']

function presetOf(rule: RecurrenceRule | null): RepeatPreset {
  return rule?.frequency ?? 'none'
}

function ruleFor(preset: RepeatPreset, startDate: string): RecurrenceRule | null {
  if (preset === 'none') return null
  if (preset === 'weekly') {
    const codes = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']
    const dow = new Date(`${startDate}T12:00:00`).getDay()
    return { frequency: 'weekly', byDay: [codes[dow]!] }
  }
  return { frequency: preset }
}

export function EventDialog({
  initial,
  calendars,
  accountId,
  self,
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
  onSave: (e: CalendarEvent) => void
  onDelete: (() => void) | null
  onRsvp: (status: ParticipationStatus) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [calendarId, setCalendarId] = useState(
    Object.keys(initial.calendarIds)[0] ?? calendars?.[0]?.id ?? '',
  )
  const [date, setDate] = useState(initial.start.slice(0, 10))
  const [time, setTime] = useState(initial.start.slice(11, 16) || '10:00')
  const [duration, setDuration] = useState(initial.duration || 'PT1H')
  const [allDay, setAllDay] = useState(initial.showWithoutTime)
  const [location, setLocation] = useState(initial.location)
  const [description, setDescription] = useState(initial.description)
  const [repeat, setRepeat] = useState<RepeatPreset>(presetOf(initial.recurrenceRule))
  const [participants, setParticipants] = useState<Participant[]>(initial.participants)

  // On an invitation the organizer owns the event; we may only answer it.
  const me = initial.participants.find(
    (p) => !p.isOrganizer && p.email.toLowerCase() === self.email.trim().toLowerCase(),
  )

  function save() {
    if (!title.trim() || !date) return
    onSave({
      ...initial,
      calendarIds: calendarId ? { [calendarId]: true } : initial.calendarIds,
      title: title.trim(),
      start: allDay ? `${date}T00:00:00` : `${date}T${time}:00`,
      duration: allDay ? 'P1D' : duration,
      showWithoutTime: allDay,
      location: location.trim(),
      description: description.trim(),
      recurrenceRule:
        presetOf(initial.recurrenceRule) === repeat
          ? initial.recurrenceRule
          : ruleFor(repeat, date),
      participants,
    })
  }

  const shell = (children: ReactNode) => (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="animate-rise w-full space-y-3 bg-raised p-5 sm:max-w-md sm:rounded-panel sm:shadow-overlay sm:ring-1 sm:ring-line"
        onClick={(e) => e.stopPropagation()}
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
        <h2 className="text-base font-semibold">{t('cal.invitation')}</h2>
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
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          {t('cal.close')}
        </button>
      </>,
    )
  }

  return shell(
    <>
      <h2 className="text-base font-semibold">
        {initial.id ? t('cal.editEvent') : t('cal.newEvent')}
      </h2>
      <input
        className={inputClass}
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
        >
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
      <div className="flex gap-2">
        <label className="flex-1 space-y-1">
          <span className="text-xs text-ink-muted">{t('cal.startDate')}</span>
          <input
            className={inputClass}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {!allDay && (
          <>
            <label className="space-y-1">
              <span className="text-xs text-ink-muted">{t('cal.startTime')}</span>
              <input
                className={inputClass}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-ink-muted">{t('cal.duration')}</span>
              <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
                {DURATIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
          </>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        {t('cal.allDay')}
      </label>
      <Select
        aria-label={t('cal.repeat')}
        value={repeat}
        onChange={(e) => setRepeat(e.target.value as RepeatPreset)}
      >
        <option value="none">{t('cal.repeat.none')}</option>
        <option value="daily">{t('cal.repeat.daily')}</option>
        <option value="weekly">{t('cal.repeat.weekly')}</option>
        <option value="monthly">{t('cal.repeat.monthly')}</option>
        <option value="yearly">{t('cal.repeat.yearly')}</option>
      </Select>
      <input
        className={inputClass}
        placeholder={t('cal.location')}
        value={location}
        onChange={(e) => setLocation(e.target.value)}
      />
      <textarea
        className={`${inputClass} min-h-16`}
        placeholder={t('cal.descriptionField')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <ParticipantsField
        value={participants}
        onChange={setParticipants}
        accountId={accountId}
        self={self}
      />
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} className={primaryButtonClass}>
          {participants.length > 0 ? t('cal.saveAndInvite') : t('cal.save')}
        </button>
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          {t('cal.cancel')}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto text-sm text-danger hover:underline"
          >
            {t('cal.delete')}
          </button>
        )}
      </div>
    </>,
  )
}
