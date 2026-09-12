import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailBody } from '../domain/email'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'

const getEmailBodyFromServer = vi.fn(async (_id: string) => body())
const getEmailMetadata = vi.fn(async (_id: string) => ({ headers: [] }) as unknown)
let mailProvider: unknown = {
  getEmailBody: (id: string) => getEmailBodyFromServer(id),
  getEmailMetadata: (id: string) => getEmailMetadata(id),
}

vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ mail: mailProvider }),
}))

const { getEmailBody, getMessageMetadata } = await import('./mail')

const ACC = 'acc'

function body(over: Partial<EmailBody> = {}): EmailBody {
  return {
    emailId: 'm1',
    html: null,
    text: 'the body',
    attachments: [],
    messageId: null,
    references: null,
    ...over,
  } as EmailBody
}

beforeEach(async () => {
  vi.clearAllMocks()
  getEmailBodyFromServer.mockImplementation(async () => body())
  mailProvider = {
    getEmailBody: (id: string) => getEmailBodyFromServer(id),
    getEmailMetadata: (id: string) => getEmailMetadata(id),
  }
  await db.bodyCache.where('accountId').equals(ACC).delete()
})

describe('reading a message body', () => {
  it('fetches it once and keeps it', async () => {
    // The cache is what makes an already-read message readable offline, and
    // what stops reopening a thread refetching every message in it.
    await getEmailBody(ACC, 'm1')
    const second = await getEmailBody(ACC, 'm1')

    expect(getEmailBodyFromServer).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ text: 'the body' })
  })

  it('answers from the cache without asking the server at all', async () => {
    await db.bodyCache.put({
      accountId: ACC,
      emailId: 'cached',
      lastAccess: 0,
      payload: sealPlain(body({ emailId: 'cached', text: 'from the cache' })),
    })

    await expect(getEmailBody(ACC, 'cached')).resolves.toMatchObject({ text: 'from the cache' })
    expect(getEmailBodyFromServer).not.toHaveBeenCalled()
  })

  it('marks a cached body as used, which is what decides eviction', async () => {
    await db.bodyCache.put({
      accountId: ACC,
      emailId: 'cached',
      lastAccess: 0,
      payload: sealPlain(body({ emailId: 'cached' })),
    })

    await getEmailBody(ACC, 'cached')
    // The update is fired without being awaited, so give it the tick it needs.
    await new Promise((r) => setTimeout(r, 0))

    expect((await db.bodyCache.get([ACC, 'cached']))!.lastAccess).toBeGreaterThan(0)
  })

  it('caches nothing when the server has no body to give', async () => {
    // A stored null would answer for the message for ever, and the real body
    // would never be fetched again.
    getEmailBodyFromServer.mockResolvedValue(null as never)

    await expect(getEmailBody(ACC, 'gone')).resolves.toBeNull()
    expect(await db.bodyCache.get([ACC, 'gone'])).toBeUndefined()
  })

  it('is null on a server with no mail at all, rather than throwing', async () => {
    mailProvider = null
    await expect(getEmailBody(ACC, 'm1')).resolves.toBeNull()
  })
})

describe('the raw headers behind the details view', () => {
  it('always asks the server, so what is shown is what is there now', async () => {
    /*
     * Deliberately not cached: unlike a body this is opened rarely and on
     * purpose, and caching it would leave routing information about every
     * message anyone ever inspected sitting in IndexedDB.
     */
    await getMessageMetadata(ACC, 'm1')
    await getMessageMetadata(ACC, 'm1')

    expect(getEmailMetadata).toHaveBeenCalledTimes(2)
    expect(await db.bodyCache.where('accountId').equals(ACC).count()).toBe(0)
  })

  it('is null without a mail provider', async () => {
    mailProvider = null
    await expect(getMessageMetadata(ACC, 'm1')).resolves.toBeNull()
  })
})
