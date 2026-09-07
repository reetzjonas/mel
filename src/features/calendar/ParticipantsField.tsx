import { useEffect, useState } from 'react'
import type { Participant, ParticipationStatus } from '../../domain/calendar'
import { t, type MsgKey } from '../../lib/i18n'
import { suggestRecipients, type Suggestion } from '../../services/contacts'
import { Icon } from '../../ui/Icon'
import { inputClass } from '../../ui/styles'

const STATUS_LABEL: Record<ParticipationStatus, MsgKey> = {
  'needs-action': 'cal.rsvp.pending',
  accepted: 'cal.rsvp.accepted',
  declined: 'cal.rsvp.declined',
  tentative: 'cal.rsvp.tentative',
}

const STATUS_TONE: Record<ParticipationStatus, string> = {
  'needs-action': 'text-ink-muted',
  accepted: 'text-success',
  declined: 'text-danger',
  tentative: 'text-honey',
}

export function ParticipantStatusBadge({ status }: { status: ParticipationStatus }) {
  return <span className={`text-xs ${STATUS_TONE[status]}`}>{t(STATUS_LABEL[status])}</span>
}

/** A participant row: name/address plus their reply state. */
function Row({ p, onRemove }: { p: Participant; onRemove: (() => void) | null }) {
  return (
    <li className="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-surface-2">
      <span className="min-w-0 flex-1 truncate">
        {p.name ? (
          <>
            {p.name} <span className="text-ink-muted">{p.email}</span>
          </>
        ) : (
          p.email
        )}
      </span>
      {p.isOrganizer ? (
        <span className="text-xs text-ink-muted">{t('cal.organizer')}</span>
      ) : (
        <ParticipantStatusBadge status={p.status} />
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${t('cal.removeAttendee')} ${p.email}`}
          className="text-ink-muted hover:text-ink"
        >
          <Icon name="close" className="size-4" />
        </button>
      )}
    </li>
  )
}

/**
 * Attendee editor for the organizer's copy of an event. Adding the first
 * attendee also pins the organizer into the list — Stalwart derives ORGANIZER
 * from the participant carrying the owner role, and without it no invitations
 * are sent.
 */
export function ParticipantsField({
  value,
  onChange,
  accountId,
  self,
}: {
  value: Participant[]
  onChange: (next: Participant[]) => void
  accountId: string
  self: { name: string; email: string }
}) {
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  useEffect(() => {
    if (input.trim().length < 2) {
      setSuggestions([])
      return
    }
    let cancelled = false
    void suggestRecipients(accountId, input).then((s) => {
      if (!cancelled) setSuggestions(s.filter((x) => !value.some((p) => p.email === x.email)))
    })
    return () => {
      cancelled = true
    }
  }, [input, accountId, value])

  function add(email: string, name: string) {
    const addr = email.trim()
    if (!addr || !addr.includes('@')) return
    if (value.some((p) => p.email.toLowerCase() === addr.toLowerCase())) {
      setInput('')
      return
    }
    const organizer: Participant[] = value.length
      ? []
      : [
          {
            id: crypto.randomUUID(),
            email: self.email,
            name: self.name,
            isOrganizer: true,
            required: true,
            status: 'accepted',
            expectReply: false,
          },
        ]
    onChange([
      ...value,
      ...organizer,
      {
        id: crypto.randomUUID(),
        email: addr,
        name: name.trim(),
        isOrganizer: false,
        required: true,
        status: 'needs-action',
        expectReply: true,
      },
    ])
    setInput('')
    setSuggestions([])
  }

  function remove(id: string) {
    const next = value.filter((p) => p.id !== id)
    // A lone organizer is not a meeting — drop back to a plain event.
    onChange(next.every((p) => p.isOrganizer) ? [] : next)
  }

  return (
    <div className="space-y-1">
      <span className="text-xs text-ink-muted">{t('cal.attendees')}</span>
      {value.length > 0 && (
        <ul className="space-y-0.5">
          {value.map((p) => (
            <Row key={p.id} p={p} onRemove={p.isOrganizer ? null : () => remove(p.id)} />
          ))}
        </ul>
      )}
      <div className="relative">
        <input
          className={inputClass}
          placeholder={t('cal.addAttendee')}
          aria-label={t('cal.addAttendee')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              const top = suggestions[0]
              if (top && !input.includes('@')) add(top.email, top.name)
              else add(input, '')
            }
          }}
        />
        {suggestions.length > 0 && (
          <ul className="absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
            {suggestions.map((s) => (
              <li key={`${s.email}-${s.name}`}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => add(s.email, s.name)}
                >
                  {s.name} <span className="text-ink-muted">{s.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
