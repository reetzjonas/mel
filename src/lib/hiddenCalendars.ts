import { useEffect, useState } from 'react'

/**
 * Per-account calendar visibility toggles.
 *
 * Stored per device (localStorage), like the theme and the conversation-view
 * toggle — but see `services/settings.ts`, which mirrors it to the server
 * for accounts that offer file storage. That mirroring is why this module
 * (moved out of `app/routes/calendar.tsx`, which `services/settings.ts`
 * cannot cleanly import) fires an event on every write rather than only
 * updating its own `useState`: a value applied from a remote sync has to
 * reach an already-mounted calendar view, not just the next one that mounts.
 */
const EVENT = 'mel:hidden-calendars'

export function hiddenCalendarsKey(accountId: string): string {
  return `mel:cal:hidden:${accountId}`
}

export function readHiddenCalendars(accountId: string): string[] {
  try {
    const raw = localStorage.getItem(hiddenCalendarsKey(accountId))
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

/** Write a remote value in directly, without the toggle's own event dispatch loop. */
export function applyHiddenCalendarsSilently(accountId: string, ids: string[]): void {
  localStorage.setItem(hiddenCalendarsKey(accountId), JSON.stringify(ids))
  window.dispatchEvent(new Event(EVENT))
}

export function useHiddenCalendars(accountId: string | undefined) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!accountId) return
    /*
     * localStorage is an external system and the account it is keyed by can
     * change, so this is a synchronisation rather than derivable state. A
     * lazy initialiser would read it once and then answer for the wrong
     * account after a switch — and would miss a value a remote sync applies
     * while this is already mounted.
     */
    const read = () => setHidden(new Set(readHiddenCalendars(accountId)))
    read()
    window.addEventListener(EVENT, read)
    return () => window.removeEventListener(EVENT, read)
  }, [accountId])

  const toggle = (calendarId: string) => {
    if (!accountId) return
    setHidden((cur) => {
      const next = new Set(cur)
      if (next.has(calendarId)) next.delete(calendarId)
      else next.add(calendarId)
      localStorage.setItem(hiddenCalendarsKey(accountId), JSON.stringify([...next]))
      return next
    })
  }

  return { hidden, toggle }
}
