import { describe, expect, it } from 'vitest'
import { parseIcs } from './icalendar'

function ics(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n')
}

describe('parseIcs', () => {
  it('reads a zoned invitation with an explicit end', () => {
    const parsed = parseIcs(
      ics(
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        'UID:abc-123',
        'SUMMARY:Sprint review',
        'LOCATION:Room 2',
        'DTSTART;TZID=Europe/Berlin:20260812T140000',
        'DTEND;TZID=Europe/Berlin:20260812T153000',
        'ORGANIZER;CN=Alice:mailto:alice@example.com',
        'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com',
        'END:VEVENT',
      ),
    )
    expect(parsed?.method).toBe('REQUEST')
    expect(parsed?.organizer).toEqual({ name: 'Alice', email: 'alice@example.com' })
    expect(parsed?.attendees).toEqual([{ name: 'Bob', email: 'bob@example.com' }])
    expect(parsed?.event).toMatchObject({
      uid: 'abc-123',
      title: 'Sprint review',
      location: 'Room 2',
      start: '2026-08-12T14:00:00',
      timeZone: 'Europe/Berlin',
      duration: 'PT1H30M',
      showWithoutTime: false,
      status: 'confirmed',
    })
  })

  it('keeps UTC times as UTC rather than guessing a zone', () => {
    const parsed = parseIcs(
      ics('BEGIN:VEVENT', 'DTSTART:20260812T120000Z', 'DTEND:20260812T130000Z', 'END:VEVENT'),
    )
    expect(parsed?.event.timeZone).toBe('UTC')
    expect(parsed?.event.start).toBe('2026-08-12T12:00:00')
    expect(parsed?.event.duration).toBe('PT1H')
  })

  it('treats a zone it cannot resolve as floating', () => {
    const parsed = parseIcs(
      ics('BEGIN:VEVENT', 'DTSTART;TZID=W. Europe Standard Time:20260812T140000', 'END:VEVENT'),
    )
    expect(parsed?.event.timeZone).toBeNull()
    expect(parsed?.event.start).toBe('2026-08-12T14:00:00')
  })

  it('turns an exclusive DTEND date into whole days', () => {
    const parsed = parseIcs(
      ics('BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260812', 'DTEND;VALUE=DATE:20260814', 'END:VEVENT'),
    )
    expect(parsed?.event.showWithoutTime).toBe(true)
    expect(parsed?.event.duration).toBe('P2D')
    expect(parsed?.event.start).toBe('2026-08-12T00:00:00')
  })

  it('falls back to an hour when neither end nor duration is given', () => {
    const parsed = parseIcs(ics('BEGIN:VEVENT', 'DTSTART:20260812T120000Z', 'END:VEVENT'))
    expect(parsed?.event.duration).toBe('PT1H')
  })

  it('prefers an explicit DURATION', () => {
    const parsed = parseIcs(
      ics('BEGIN:VEVENT', 'DTSTART:20260812T120000Z', 'DURATION:PT45M', 'END:VEVENT'),
    )
    expect(parsed?.event.duration).toBe('PT45M')
  })

  it('unfolds long lines and unescapes text', () => {
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'DTSTART:20260812T120000Z',
        'SUMMARY:Lunch with Bob\\, Carol',
        'DESCRIPTION:First line\\nSecond line',
        '  and still the second',
        'END:VEVENT',
      ),
    )
    expect(parsed?.event.title).toBe('Lunch with Bob, Carol')
    expect(parsed?.event.description).toBe('First line\nSecond line and still the second')
  })

  it('reads a recurrence rule it can store', () => {
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'DTSTART:20260812T120000Z',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T000000Z',
        'END:VEVENT',
      ),
    )
    expect(parsed?.event.recurrenceRule).toEqual({
      frequency: 'weekly',
      interval: 2,
      byDay: ['mo', 'we'],
      until: '2026-12-31T00:00:00',
    })
  })

  it('drops a frequency it cannot expand instead of guessing', () => {
    const parsed = parseIcs(
      ics('BEGIN:VEVENT', 'DTSTART:20260812T120000Z', 'RRULE:FREQ=HOURLY', 'END:VEVENT'),
    )
    expect(parsed?.event.recurrenceRule).toBeNull()
  })

  it('ignores alarms nested in the event', () => {
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'DTSTART:20260812T120000Z',
        'SUMMARY:Standup',
        'BEGIN:VALARM',
        'TRIGGER:-PT15M',
        'SUMMARY:Reminder',
        'END:VALARM',
        'END:VEVENT',
      ),
    )
    expect(parsed?.event.title).toBe('Standup')
  })

  it('prefers the master event over a single-occurrence override', () => {
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:x',
        'RECURRENCE-ID:20260819T120000Z',
        'DTSTART:20260819T140000Z',
        'SUMMARY:Moved',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:x',
        'DTSTART:20260812T120000Z',
        'SUMMARY:Weekly',
        'END:VEVENT',
      ),
    )
    expect(parsed?.event.title).toBe('Weekly')
  })

  it('carries a cancellation through', () => {
    const parsed = parseIcs(
      ics(
        'METHOD:CANCEL',
        'BEGIN:VEVENT',
        'DTSTART:20260812T120000Z',
        'STATUS:CANCELLED',
        'END:VEVENT',
      ),
    )
    expect(parsed?.method).toBe('CANCEL')
    expect(parsed?.event.status).toBe('cancelled')
  })

  it('never carries participants into the copy we would create', () => {
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'DTSTART:20260812T120000Z',
        'ORGANIZER:mailto:alice@example.com',
        'ATTENDEE:mailto:bob@example.com',
        'END:VEVENT',
      ),
    )
    expect(parsed?.event.participants).toEqual([])
    expect(parsed?.event.isOrganizerCopy).toBe(true)
  })

  /*
   * A real iMIP request as Stalwart sends it: a VTIMEZONE component sits ahead
   * of the event, parameters are folded mid-word, and there is no DTEND.
   */
  it('reads a real iMIP request without tripping over VTIMEZONE', () => {
    const parsed = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Stalwart Labs LLC//Stalwart Server//EN',
        'METHOD:REQUEST',
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:DAYLIGHT',
        'DTSTART:20260329T020000',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'DTSTAMP:20260911T114256Z',
        'UID:12216a8e-1bd0-4ff7-8788-e6753a8aa14c',
        'DTSTART;TZID=Europe/Berlin:20261015T100000',
        'SUMMARY:Invite-75460',
        'DURATION:PT1H',
        'ATTENDEE;ROLE=CHAIR,REQ-PARTICIPANT;RSVP=FALSE;PARTSTAT=ACCEPTED;CN="Alice',
        ' (dev)";JSID=4e0144cd:mailto:alice@localhost',
        'ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;JSID=63db8b24:mailto:bob@localhost',
        'ORGANIZER;CN="Alice (dev)":mailto:alice@localhost',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    )
    expect(parsed?.method).toBe('REQUEST')
    expect(parsed?.organizer).toEqual({ name: 'Alice (dev)', email: 'alice@localhost' })
    expect(parsed?.attendees.map((a) => a.email)).toEqual(['alice@localhost', 'bob@localhost'])
    expect(parsed?.event).toMatchObject({
      uid: '12216a8e-1bd0-4ff7-8788-e6753a8aa14c',
      title: 'Invite-75460',
      start: '2026-10-15T10:00:00',
      timeZone: 'Europe/Berlin',
      duration: 'PT1H',
      recurrenceRule: null,
    })
  })

  it('rejects payloads without an event or without a start', () => {
    expect(parseIcs('not an ics at all')).toBeNull()
    expect(parseIcs(ics('BEGIN:VTODO', 'DTSTART:20260812T120000Z', 'END:VTODO'))).toBeNull()
    expect(parseIcs(ics('BEGIN:VEVENT', 'SUMMARY:No when', 'END:VEVENT'))).toBeNull()
  })

  it('falls back to an hour when the end is before the start', () => {
    /*
     * A negative duration is not storable and would render as an event that
     * ends before it begins. Senders do produce these — a timezone applied to
     * one end and not the other is enough.
     */
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:backwards',
        'DTSTART:20260812T150000Z',
        'DTEND:20260812T140000Z',
        'END:VEVENT',
      ),
    )

    expect(parsed?.event.duration).toBe('PT1H')
  })

  it('measures a zoned event across a DST switch as the time it really takes', () => {
    /*
     * 01:30 to 04:30 on the night the clocks go forward in Berlin is two
     * hours of real time, not the three the wall clock shows. The expected
     * value is deliberately neither: PT3H would mean wall clock, PT1H the
     * fallback used when the measurement throws.
     */
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:dst',
        'DTSTART;TZID=Europe/Berlin:20260329T013000',
        'DTEND;TZID=Europe/Berlin:20260329T043000',
        'END:VEVENT',
      ),
    )

    expect(parsed?.event.duration).toBe('PT2H')
  })

  it('ignores a duration that is zero or backwards', () => {
    for (const value of ['PT0S', '-PT1H', 'nonsense']) {
      const parsed = parseIcs(
        ics('BEGIN:VEVENT', 'UID:d', 'DTSTART:20260812T140000Z', `DURATION:${value}`, 'END:VEVENT'),
      )
      expect(parsed?.event.duration, value).toBe('PT1H')
    }
  })

  it('skips an attendee line that carries no address', () => {
    // Some senders write a directory entry or a bare name there; adding it as
    // a participant would put a row in the invitation nobody can reply as.
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:u',
        'DTSTART:20260812T140000Z',
        'ATTENDEE;CN=Room 2:Conference Room 2',
        'ATTENDEE;CN=Bob:mailto:bob@example.com',
        'END:VEVENT',
      ),
    )

    expect(parsed?.attendees).toEqual([{ name: 'Bob', email: 'bob@example.com' }])
  })

  it('takes an address written without the mailto scheme', () => {
    const parsed = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:u',
        'DTSTART:20260812T140000Z',
        'ORGANIZER:alice@example.com',
        'END:VEVENT',
      ),
    )

    expect(parsed?.organizer).toEqual({ name: '', email: 'alice@example.com' })
  })

  it('ignores a start it cannot read at all', () => {
    // A malformed DTSTART is the one field there is no sensible default for.
    expect(parseIcs(ics('BEGIN:VEVENT', 'UID:u', 'DTSTART:not-a-date', 'END:VEVENT'))).toBeNull()
  })
})
