import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, EventAlerts } from '../domain/calendar'
import type { Note } from '../domain/note'
import type { PendingAlert } from '../lib/alerts'
import { useUi } from '../app/store'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'
import {
  deliverReminders,
  describeAlert,
  readFired,
  runReminders,
  startEventReminders,
} from './eventReminders'

const ZONE = 'Europe/Berlin'

const alerts = (offset: string): EventAlerts => ({
  a1: { trigger: { '@type': 'OffsetTrigger', offset, relativeTo: 'start' }, action: 'display' },
})

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1',
  calendarIds: { c: true },
  uid: 'u1',
  title: 'Standup',
  description: '',
  location: 'Room 4',
  start: '2026-08-03T10:00:00', // 08:00Z
  timeZone: ZONE,
  duration: 'PT1H',
  showWithoutTime: false,
  status: 'confirmed',
  recurrenceRule: null,
  recurrenceOverrides: {},
  participants: [],
  isOrganizerCopy: true,
  alerts: alerts('-PT15M'),
  ...over,
})

describe('running the reminders', () => {
  const shown = vi.fn<(a: PendingAlert[], now: Date) => boolean>()
  beforeEach(() => shown.mockReset().mockReturnValue(true))

  it('shows what is due and marks it, so the next run stays quiet', () => {
    const now = new Date('2026-08-03T07:46:00Z')
    const first = runReminders([event()], now, {}, ZONE, shown)
    expect(shown).toHaveBeenCalledTimes(1)
    expect(shown.mock.calls[0]![0].map((a) => a.title)).toEqual(['Standup'])
    expect(Object.keys(first.fired)).toHaveLength(1)

    runReminders([event()], new Date('2026-08-03T07:47:00Z'), first.fired, ZONE, shown)
    expect(shown).toHaveBeenCalledTimes(1)
  })

  it('names the moment to look again when the next one is still ahead', () => {
    const now = new Date('2026-08-03T07:00:00Z')
    const r = runReminders([event()], now, {}, ZONE, shown)
    expect(shown).not.toHaveBeenCalled()
    expect(r.nextAt?.toISOString()).toBe('2026-08-03T07:45:00.000Z')
  })

  it('leaves an alert unmarked when it could not be shown, so it is tried again', () => {
    shown.mockReturnValue(false)
    const now = new Date('2026-08-03T07:46:00Z')
    const r = runReminders([event()], now, {}, ZONE, shown)
    expect(r.fired).toEqual({})
    runReminders([event()], now, r.fired, ZONE, shown)
    expect(shown).toHaveBeenCalledTimes(2)
  })

  it('plans due notes alongside events, whichever comes first', () => {
    const due: Note = {
      id: 'n1',
      folderId: 'n1',
      fileId: 'n1',
      folderName: 'n1',
      title: 'Taxes',
      body: '',
      pinned: false,
      due: '2026-08-03',
      linkedTo: null,
      extra: {},
      modified: '',
    }
    const now = new Date(2026, 7, 3, 0, 30)
    const r = runReminders([], now, {}, ZONE, shown, [due])
    expect(shown).not.toHaveBeenCalled()
    expect(r.nextAt).toEqual(new Date(2026, 7, 3, 9))
    runReminders([], new Date(2026, 7, 3, 9, 1), {}, ZONE, shown, [due])
    expect(shown.mock.calls[0]![0]).toMatchObject([{ kind: 'note', title: 'Taxes' }])
  })

  it('shows an alert again when its event is moved, since that is a new moment', () => {
    const before = runReminders([event()], new Date('2026-08-03T07:46:00Z'), {}, ZONE, shown)
    const moved = event({ start: '2026-08-03T16:00:00' })
    runReminders([moved], new Date('2026-08-03T13:50:00Z'), before.fired, ZONE, shown)
    expect(shown).toHaveBeenCalledTimes(2)
  })
})

describe('what a reminder says', () => {
  const alert = (over: Partial<PendingAlert> = {}): PendingAlert => ({
    key: 'k',
    eventId: 'e1',
    title: 'Standup',
    location: 'Room 4',
    start: new Date('2026-08-03T08:00:00Z'),
    end: new Date('2026-08-03T09:00:00Z'),
    allDay: false,
    fireAt: new Date('2026-08-03T07:45:00Z'),
    ...over,
  })

  it('leads with how long is left, then the time and the place', () => {
    const { title, body } = describeAlert(alert(), new Date('2026-08-03T07:45:00Z'))
    expect(title).toBe('Standup')
    expect(body).toMatch(/^in 15 minutes · .+ · Room 4$/)
  })

  it('speaks in hours and days for longer leads', () => {
    expect(describeAlert(alert(), new Date('2026-08-03T06:00:00Z')).body).toMatch(/^in 2 hours/)
    expect(describeAlert(alert(), new Date('2026-08-01T08:00:00Z')).body).toMatch(/^in 2 days/)
  })

  it('says so when it has already started', () => {
    expect(describeAlert(alert(), new Date('2026-08-03T08:10:00Z')).body).toMatch(/^10 minutes ago/)
  })

  it('has no clock time for an all-day event, and no place when there is none', () => {
    const { body } = describeAlert(
      alert({ allDay: true, location: '' }),
      new Date('2026-08-03T07:45:00Z'),
    )
    expect(body).toBe('in 15 minutes · All day')
  })
})

describe('what a note reminder says', () => {
  it('names the note and that it is due today', () => {
    const { title, body } = describeAlert(
      {
        key: 'k',
        eventId: 'n1',
        title: '',
        location: '',
        start: new Date(2026, 7, 3),
        end: new Date(2026, 7, 4),
        allDay: true,
        fireAt: new Date(2026, 7, 3, 9),
        kind: 'note',
      },
      new Date(2026, 7, 3, 9),
    )
    expect(title).toBe('Untitled note')
    expect(body).toBe('Due today')
  })
})

describe('the record of what was shown', () => {
  it('reads as empty when storage holds nothing usable', () => {
    localStorage.setItem('mel:reminded:x', '{oops')
    expect(readFired('x')).toEqual({})
    expect(readFired('never-written')).toEqual({})
  })
})

describe('delivering a reminder', () => {
  const alert: PendingAlert = {
    key: 'k1',
    eventId: 'e1',
    title: 'Standup',
    location: '',
    start: new Date('2026-08-03T08:00:00Z'),
    end: new Date('2026-08-03T09:00:00Z'),
    allDay: false,
    fireAt: new Date('2026-08-03T07:45:00Z'),
  }
  const now = new Date('2026-08-03T07:45:00Z')

  const setPermission = (value: NotificationPermission) =>
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: value }))
  const setHidden = (hidden: boolean) =>
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })

  beforeEach(() => {
    useUi.getState().hideSnackbar()
    setHidden(false)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a system notification through the service worker when permitted', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined)
    setPermission('granted')
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) },
    })
    expect(deliverReminders([alert], now)).toBe(true)
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    const [title, options] = showNotification.mock.calls[0]!
    expect(title).toBe('Standup')
    expect(options).toMatchObject({ tag: 'mel-reminder-k1', data: { url: '/calendar' } })
    // Nothing in the page as well: one or the other.
    expect(useUi.getState().snackbar).toBeNull()
  })

  it('leads a note reminder to the note', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined)
    setPermission('granted')
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) },
    })
    deliverReminders([{ ...alert, eventId: 'n1', kind: 'note' }], now)
    await vi.waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1))
    expect(showNotification.mock.calls[0]![1]).toMatchObject({ data: { url: '/notes/n1' } })
  })

  it('falls back to the page notification where there is no service worker', async () => {
    setPermission('granted')
    vi.stubGlobal('navigator', {})
    expect(deliverReminders([alert], now)).toBe(true)
    await vi.waitFor(() => expect(Notification).toHaveBeenCalledTimes(1))
  })

  it('tells the person in the page when there is no permission and the page is in view', () => {
    setPermission('denied')
    expect(deliverReminders([alert], now)).toBe(true)
    expect(useUi.getState().snackbar?.message).toMatch(/^Standup — in 15 minutes$/)
  })

  it('does not count it as shown when nobody could see it', () => {
    setPermission('default')
    setHidden(true)
    expect(deliverReminders([alert], now)).toBe(false)
    expect(useUi.getState().snackbar).toBeNull()
  })

  it('shows at most five, however many are due', () => {
    setPermission('denied')
    const many = Array.from({ length: 8 }, (_, i) => ({ ...alert, key: `k${i}`, title: `T${i}` }))
    deliverReminders(many, now)
    expect(useUi.getState().snackbar?.message.split('; ')).toHaveLength(5)
  })
})

describe('running for an account', () => {
  const ACC = 'acc-rem'
  const put = (e: CalendarEvent) =>
    db.events.put({
      accountId: ACC,
      id: e.id,
      calendarIds: Object.keys(e.calendarIds),
      payload: sealPlain(e),
    })
  const snack = () => useUi.getState().snackbar?.message
  const stops: Array<() => void> = []
  const start = () => {
    const stop = startEventReminders(ACC)
    stops.push(stop)
    return stop
  }

  beforeEach(async () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }))
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    useUi.getState().hideSnackbar()
    localStorage.clear()
    await db.events.clear()
    await db.notes.clear()
    // 07:40Z, five minutes before the event's alert at 07:45Z.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-08-03T07:40:00Z'))
  })
  afterEach(() => {
    while (stops.length) stops.pop()!()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows an alert that is already due as soon as the events are read', async () => {
    vi.setSystemTime(new Date('2026-08-03T07:50:00Z'))
    await put(event())
    start()
    await vi.waitFor(() => expect(snack()).toMatch(/^Standup — in 10 minutes$/))
    // Remembered, so a second start (another tab, a reload) does not repeat it.
    expect(Object.keys(readFired(ACC))).toHaveLength(1)
  })

  it('waits for the moment and shows it then', async () => {
    await put(event())
    start()
    // Long enough for the first read to land and the timer to be set, not for the alert.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(snack()).toBeUndefined()
    // The snackbar hides itself after a few seconds, so look just after the moment.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(snack()).toMatch(/^Standup — in /)
  })

  it('does not repeat one it already showed', async () => {
    vi.setSystemTime(new Date('2026-08-03T07:50:00Z'))
    await put(event())
    const stop = start()
    await vi.waitFor(() => expect(snack()).toBeDefined())
    stop()
    useUi.getState().hideSnackbar()
    start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(snack()).toBeUndefined()
  })

  it('is one run per account, and stops when told to', async () => {
    const stop = start()
    expect(startEventReminders(ACC)).toBe(stop)
    stop()
    await put(event())
    vi.setSystemTime(new Date('2026-08-03T07:50:00Z'))
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(snack()).toBeUndefined()
  })

  it('keeps quiet for a calendar switched off in the sidebar', async () => {
    localStorage.setItem('mel:cal:hidden:acc-rem', JSON.stringify(['c']))
    vi.setSystemTime(new Date('2026-08-03T07:50:00Z'))
    await put(event())
    start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(snack()).toBeUndefined()
  })

  it('picks up an event that arrives later, as a sync would bring it', async () => {
    start()
    await vi.advanceTimersByTimeAsync(1_000)
    vi.setSystemTime(new Date('2026-08-03T07:50:00Z'))
    await put(event())
    await vi.waitFor(() => expect(snack()).toMatch(/^Standup/))
  })

  it('reminds of a note due today, whatever the calendar filter says', async () => {
    // A hidden calendar is about events; a note has none.
    localStorage.setItem('mel:cal:hidden:acc-rem', JSON.stringify(['c']))
    vi.setSystemTime(new Date(2026, 7, 3, 10))
    const note: Note = {
      id: 'n1',
      folderId: 'n1',
      fileId: 'n1',
      folderName: 'n1',
      title: 'Taxes',
      body: '',
      pinned: false,
      due: '2026-08-03',
      linkedTo: null,
      extra: {},
      modified: '',
    }
    await db.notes.put({
      accountId: ACC,
      id: note.id,
      pinned: 0,
      modified: '',
      payload: sealPlain(note),
    })
    start()
    await vi.waitFor(() => expect(snack()).toBe('Taxes — Due today'))
  })

  it('tries again when the tab comes back to the front', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default' }))
    vi.setSystemTime(new Date('2026-08-03T07:50:00Z'))
    await put(event())
    start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(snack()).toBeUndefined()
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(snack()).toMatch(/^Standup/)
  })
})
