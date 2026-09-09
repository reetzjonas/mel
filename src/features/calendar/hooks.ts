import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import type { Account } from '../../domain/account'
import type { Calendar, CalendarEvent } from '../../domain/calendar'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'
import { getIdentities } from '../../services/send'

export function useCalendars(accountId: string | undefined): Calendar[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.calendars.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload))
  }, [accountId])
}

export function useEvents(accountId: string | undefined): CalendarEvent[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.events.where('accountId').equals(accountId).toArray()
    return rows.map((r) => openEnvelope(r.payload))
  }, [accountId])
}

/**
 * The address invitations are sent as. Prefers the server identity (Stalwart
 * matches iTIP replies on it); falls back to the account label offline.
 */
export function useSelfIdentity(account: Account | undefined): { name: string; email: string } {
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null)
  const accountId = account?.id
  // Depends only on the id, not the account object: re-fetching identities on
  // every account field change (label, caps) would be wasted work.
  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    void getIdentities(accountId)
      .then((list) => {
        const primary = list.find((i) => i.email) ?? list[0]
        if (!cancelled && primary) setIdentity({ name: primary.name, email: primary.email })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [accountId])
  return identity ?? { name: '', email: account?.label ?? '' }
}
