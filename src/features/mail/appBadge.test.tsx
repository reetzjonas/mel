import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mailbox } from '../../domain/mailbox'
import { db } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { useAppBadge } from './appBadge'

const ACC = 'acc-badge'

const setAppBadge = vi.fn(() => Promise.resolve())
const clearBadge = vi.fn(() => Promise.resolve())

async function store(id: string, role: string | null, unreadEmails: number) {
  await db.mailboxes.put({
    accountId: ACC,
    id,
    parentId: null,
    role,
    sortOrder: 0,
    payload: sealPlain({
      id,
      name: id,
      role,
      parentId: null,
      sortOrder: 0,
      totalEmails: unreadEmails,
      unreadEmails,
    } as unknown as Mailbox),
  })
}

beforeEach(async () => {
  setAppBadge.mockClear()
  clearBadge.mockClear()
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge })
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearBadge })
  await db.mailboxes.where('accountId').equals(ACC).delete()
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'setAppBadge')
  Reflect.deleteProperty(navigator, 'clearAppBadge')
})

describe('the unread badge on the app icon', () => {
  it('shows what the inbox has unread', async () => {
    await store('mb-inbox', 'inbox', 4)

    renderHook(() => useAppBadge(ACC))

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(4))
  })

  it('ignores what other folders are carrying', async () => {
    /*
     * A badge that counts every folder never goes out for anyone who keeps an
     * archive full of unread mail on purpose, and a permanent badge is one
     * people stop looking at.
     */
    await store('mb-inbox', 'inbox', 0)
    await store('mb-archive', 'archive', 99)

    renderHook(() => useAppBadge(ACC))

    await waitFor(() => expect(clearBadge).toHaveBeenCalled())
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it('comes down again once the inbox has been read', async () => {
    await store('mb-inbox', 'inbox', 2)
    renderHook(() => useAppBadge(ACC))
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2))

    await store('mb-inbox', 'inbox', 0)

    await waitFor(() => expect(clearBadge).toHaveBeenCalled())
  })
})
