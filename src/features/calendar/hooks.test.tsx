import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { Account } from '../../domain/account'
import type { Identity } from '../../domain/identity'
import { db } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'

let identities: Identity[] | Error = []
vi.mock('../../services/send', () => ({
  getIdentities: () =>
    identities instanceof Error ? Promise.reject(identities) : Promise.resolve(identities),
}))

const { useCalendars, useEvents, useSelfIdentity } = await import('./hooks')

const account = (over: Partial<Account> = {}): Account =>
  ({ id: 'acc', label: 'alice@example.test', ...over }) as unknown as Account

const identity = (email: string, name = ''): Identity =>
  ({ id: `i-${email}`, email, name }) as unknown as Identity

beforeEach(() => {
  identities = []
})

describe('the address invitations go out as', () => {
  it('prefers what the server calls this account', async () => {
    /*
     * Stalwart matches an iTIP reply against the identity, so answering an
     * invitation as anything else leaves the organiser's copy unchanged and
     * the reply looking like it came from a stranger.
     */
    identities = [identity('alice@server.test', 'Alice A.')]

    const { result } = renderHook(() => useSelfIdentity(account()))

    await waitFor(() =>
      expect(result.current).toEqual({ name: 'Alice A.', email: 'alice@server.test' }),
    )
  })

  it('uses the account label until the identity arrives', async () => {
    // The dialog renders before the request finishes; an empty address there
    // would offer an RSVP that cannot be attributed to anyone.
    identities = [identity('alice@server.test')]

    const { result } = renderHook(() => useSelfIdentity(account()))

    expect(result.current).toEqual({ name: '', email: 'alice@example.test' })
  })

  it('keeps the label when the server offers no identity at all', async () => {
    const { result } = renderHook(() => useSelfIdentity(account()))
    await waitFor(() => expect(result.current.email).toBe('alice@example.test'))
  })

  it('keeps the label when the identities cannot be fetched', async () => {
    // Offline, and the calendar still has to be usable.
    identities = new Error('offline')

    const { result } = renderHook(() => useSelfIdentity(account()))

    await waitFor(() => expect(result.current.email).toBe('alice@example.test'))
  })

  it('skips an identity with no address', async () => {
    // Some servers list a placeholder identity first; picking it would send
    // the reply from nowhere.
    identities = [identity(''), identity('alice@server.test')]

    const { result } = renderHook(() => useSelfIdentity(account()))

    await waitFor(() => expect(result.current.email).toBe('alice@server.test'))
  })

  it('answers with an empty address when there is no account yet', async () => {
    const { result } = renderHook(() => useSelfIdentity(undefined))
    expect(result.current).toEqual({ name: '', email: '' })
  })
})

describe('what the calendar reads out of storage', () => {
  const ACC = 'acc'

  beforeEach(async () => {
    await db.calendars.clear()
    await db.events.clear()
  })

  it('opens the stored payloads rather than handing back index rows', async () => {
    // The month view draws from the payload — colour, name, title. The index
    // columns hold ids only, by design (everything else may be encrypted).
    await db.calendars.put({
      accountId: ACC,
      id: 'c1',
      payload: sealPlain({ id: 'c1', name: 'Privat', color: '#f00' } as never),
    })
    await db.events.put({
      accountId: ACC,
      id: 'e1',
      calendarIds: ['c1'],
      payload: sealPlain({ id: 'e1', title: 'Standup' } as never),
    })

    const calendars = renderHook(() => useCalendars(ACC))
    const events = renderHook(() => useEvents(ACC))

    await waitFor(() => expect(calendars.result.current?.[0]?.name).toBe('Privat'))
    await waitFor(() => expect(events.result.current?.[0]?.title).toBe('Standup'))
  })

  it('never reaches into another account on the same device', async () => {
    await db.events.put({
      accountId: 'other',
      id: 'theirs',
      calendarIds: ['c9'],
      payload: sealPlain({ id: 'theirs', title: 'Not mine' } as never),
    })

    const { result } = renderHook(() => useEvents(ACC))

    await waitFor(() => expect(result.current).toEqual([]))
  })

  it('is an empty list, not undefined, before an account exists', async () => {
    // The views map over this on the first render, before login has finished.
    const calendars = renderHook(() => useCalendars(undefined))
    const events = renderHook(() => useEvents(undefined))

    await waitFor(() => expect(calendars.result.current).toEqual([]))
    await waitFor(() => expect(events.result.current).toEqual([]))
  })
})
