import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'

const inboxUnreadSince = vi.fn(async (_accountId: string, _since: number) => [] as EmailHeader[])
vi.mock('../sync/scheduler', () => ({
  inboxUnreadSince: (a: string, s: number) => inboxUnreadSince(a, s),
}))

const { notifyNewMail, requestNotificationPermission } = await import('./notifications')

const ACC = 'acc-1'

const mail = (id: string, over: Partial<EmailHeader> = {}): EmailHeader =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ name: 'Ada', email: 'ada@example.test' }],
    to: [],
    cc: [],
    subject: `subject ${id}`,
    preview: '',
    receivedAt: 0,
    hasAttachment: false,
    ...over,
  }) as unknown as EmailHeader

/** Records what would have been shown, in place of the browser's own. */
function stubNotification(permission: NotificationPermission = 'granted') {
  const shown: Array<{ title: string; body?: string; tag?: string }> = []
  class FakeNotification {
    static permission = permission
    static requestPermission = vi.fn(async () => permission)
    onclick: (() => void) | null = null
    constructor(title: string, opts?: NotificationOptions) {
      shown.push({ title, body: opts?.body, tag: opts?.tag })
    }
  }
  vi.stubGlobal('Notification', FakeNotification)
  return shown
}

describe('notifyNewMail', () => {
  beforeEach(() => {
    localStorage.clear()
    inboxUnreadSince.mockClear()
    inboxUnreadSince.mockResolvedValue([])
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stays quiet until permission has actually been granted', async () => {
    const shown = stubNotification('default')
    inboxUnreadSince.mockResolvedValue([mail('m1')])

    await notifyNewMail(ACC)

    expect(shown).toEqual([])
    // And it asks the database for nothing it is not allowed to show.
    expect(inboxUnreadSince).not.toHaveBeenCalled()
  })

  it('notifies nothing on the very first sync', async () => {
    /*
     * The watermark starts at "now", so a fresh login does not fire a
     * notification for every unread message already in the mailbox — which
     * on a real account is hundreds.
     */
    const shown = stubNotification()

    await notifyNewMail(ACC)

    const since = inboxUnreadSince.mock.calls[0]![1]
    expect(since).toBeGreaterThan(Date.now() - 5_000)
    expect(shown).toEqual([])
  })

  it('asks only about mail newer than the last time it looked', async () => {
    const shown = stubNotification()
    localStorage.setItem(`mel:notified:${ACC}`, '1000')
    inboxUnreadSince.mockResolvedValue([mail('m1')])

    await notifyNewMail(ACC)

    // Strictly newer: the message that triggered the last notification must
    // not be announced a second time.
    expect(inboxUnreadSince.mock.calls[0]![1]).toBe(1001)
    expect(shown).toHaveLength(1)
  })

  it('moves the watermark on even when there was nothing to say', async () => {
    // Otherwise a quiet stretch keeps widening the window, and the next
    // arrival drags everything since the last notification along with it.
    stubNotification()
    localStorage.setItem(`mel:notified:${ACC}`, '1000')

    await notifyNewMail(ACC)

    expect(Number(localStorage.getItem(`mel:notified:${ACC}`))).toBeGreaterThan(1000)
  })

  it('shows at most five, however much arrived', async () => {
    // A sync after a long offline stretch can bring in hundreds; a stack of
    // hundreds of notifications is worse than none.
    const shown = stubNotification()
    localStorage.setItem(`mel:notified:${ACC}`, '1000')
    inboxUnreadSince.mockResolvedValue(Array.from({ length: 40 }, (_, i) => mail(`m${i}`)))

    await notifyNewMail(ACC)

    expect(shown).toHaveLength(5)
  })

  it('names the sender the way the list does, and falls back when it cannot', async () => {
    const shown = stubNotification()
    localStorage.setItem(`mel:notified:${ACC}`, '1000')
    inboxUnreadSince.mockResolvedValue([
      mail('named'),
      mail('address', { from: [{ name: null, email: 'b@example.test' }] }),
      mail('anonymous', { from: [], subject: '' }),
    ])

    await notifyNewMail(ACC)

    expect(shown.map((n) => n.title)).toEqual(['Ada', 'b@example.test', expect.any(String)])
    // An empty subject still needs a body, or the notification is a blank box.
    expect(shown[2]!.body).toBeTruthy()
  })

  it('tags each notification per account and message', async () => {
    // The tag is what stops the same message appearing twice when two syncs
    // overlap, and what keeps two accounts from collapsing into one.
    const shown = stubNotification()
    localStorage.setItem(`mel:notified:${ACC}`, '1000')
    inboxUnreadSince.mockResolvedValue([mail('m1')])

    await notifyNewMail(ACC)

    expect(shown[0]!.tag).toBe(`mel-${ACC}-m1`)
  })
})

describe('requestNotificationPermission', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not ask again once granted', async () => {
    stubNotification('granted')
    await expect(requestNotificationPermission()).resolves.toBe(true)
    expect(
      (Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> })
        .requestPermission,
    ).not.toHaveBeenCalled()
  })

  it('asks when the answer is still open, and reports what came back', async () => {
    stubNotification('default')
    await expect(requestNotificationPermission()).resolves.toBe(false)
    expect(
      (Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> })
        .requestPermission,
    ).toHaveBeenCalled()
  })

  it('is false in a browser without notifications at all', async () => {
    /*
     * Deleted, not stubbed with undefined: the guard asks `'Notification' in
     * window`, and a stub would put the key there with an empty value — a
     * state no browser is actually in. Simulating it would have "found" a
     * bug that cannot happen and invited a fix for nobody.
     */
    const original = Object.getOwnPropertyDescriptor(window, 'Notification')
    Reflect.deleteProperty(window, 'Notification')
    try {
      await expect(requestNotificationPermission()).resolves.toBe(false)
    } finally {
      if (original) Object.defineProperty(window, 'Notification', original)
    }
  })
})
