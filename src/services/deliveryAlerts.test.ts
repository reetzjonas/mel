import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUi } from '../app/store'
import type { Submission } from '../domain/submission'
import { db } from '../storage/db'
import { deliveryAlertText, markFailuresSeen, showDeliveryAlert } from './deliveryAlerts'

const ACCOUNT = 'acc-delivery'

const refused = (id: string, emails: string[]): Submission => ({
  id,
  emailId: `e-${id}`,
  sendAt: '2026-09-23T20:00:00Z',
  undoStatus: 'final',
  recipients: emails.map((email) => ({ email, delivered: 'no', smtpReply: '550' })),
})

const setPermission = (value: NotificationPermission) =>
  vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: value }))
const setHidden = (hidden: boolean) =>
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })

beforeEach(async () => {
  useUi.getState().hideSnackbar()
  setHidden(false)
  await db.mailboxes.where('accountId').equals(ACCOUNT).delete()
  await db.emails.where('accountId').equals(ACCOUNT).delete()
  await db.submissions.where('accountId').equals(ACCOUNT).delete()
  await db.mailboxes.put({
    accountId: ACCOUNT,
    id: 'sent-box',
    parentId: null,
    role: 'sent',
    sortOrder: 0,
    payload: { plain: {} },
  } as never)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saying a sent message was refused', () => {
  it('names each refused recipient once', () => {
    expect(
      deliveryAlertText([
        refused('a', ['x@example.com', 'y@example.com']),
        refused('b', ['x@example.com']),
      ]),
    ).toBe('Not delivered to x@example.com, y@example.com')
  })

  it('puts it in the page while the page is in view, leading to the message in Sent', async () => {
    const open = vi.fn()
    await showDeliveryAlert(ACCOUNT, [refused('a', ['x@example.com'])], open)
    const snackbar = useUi.getState().snackbar
    expect(snackbar?.message).toBe('Not delivered to x@example.com')
    snackbar?.action?.()
    expect(open).toHaveBeenCalledWith('/mail/sent-box/e-a')
  })

  it('shows a system notification with the subject while the page is out of sight', async () => {
    setHidden(true)
    setPermission('granted')
    const showNotification = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) },
    })
    await db.emails.put({
      accountId: ACCOUNT,
      id: 'e-a',
      mailboxIds: ['sent-box'],
      payload: { plain: { subject: 'Quarterly numbers' } },
    } as never)

    await showDeliveryAlert(ACCOUNT, [refused('a', ['x@example.com'])], vi.fn())

    const [title, options] = showNotification.mock.calls[0]!
    expect(title).toBe('Not delivered')
    expect(options).toMatchObject({
      body: '“Quarterly numbers” · Not delivered to x@example.com',
      tag: 'mel-undelivered-a',
      data: { url: '/mail/sent-box/e-a' },
    })
    expect(useUi.getState().snackbar).toBeNull()
  })

  it('falls back to the page notification where there is no service worker', async () => {
    setHidden(true)
    setPermission('granted')
    vi.stubGlobal('navigator', {})
    await showDeliveryAlert(ACCOUNT, [refused('a', ['x@example.com'])], vi.fn())
    expect(Notification).toHaveBeenCalledWith(
      'Not delivered',
      expect.objectContaining({ body: 'Not delivered to x@example.com' }),
    )
  })

  it('stays quiet out of sight without permission: the folder mark is still there later', async () => {
    setHidden(true)
    setPermission('denied')
    await showDeliveryAlert(ACCOUNT, [refused('a', ['x@example.com'])], vi.fn())
    expect(Notification).not.toHaveBeenCalled()
    expect(useUi.getState().snackbar).toBeNull()
  })

  it('does nothing for nothing', async () => {
    await showDeliveryAlert(ACCOUNT, [], vi.fn())
    expect(useUi.getState().snackbar).toBeNull()
  })
})

describe('markFailuresSeen', () => {
  it('marks every submission of that message, and only that message', async () => {
    const a = refused('a', ['x@example.com'])
    const b = refused('b', ['x@example.com'])
    await db.submissions.bulkPut([
      { accountId: ACCOUNT, id: 'a', emailId: a.emailId, seen: 0, payload: { plain: a } },
      { accountId: ACCOUNT, id: 'b', emailId: b.emailId, payload: { plain: b } },
    ])
    await markFailuresSeen(ACCOUNT, 'e-a')
    expect((await db.submissions.get([ACCOUNT, 'a']))?.seen).toBe(1)
    expect((await db.submissions.get([ACCOUNT, 'b']))?.seen).toBeUndefined()
  })
})
