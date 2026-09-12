import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailBody } from '../domain/email'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'

const getEmailBodyFromServer = vi.fn(async (_id: string) => body())
const getEmailMetadata = vi.fn(async (_id: string) => ({ headers: [] }) as unknown)
const downloadBlob = vi.fn(
  async (_blobId: string, _type: string, _name: string) => new Blob(['BEGIN:VCALENDAR']),
)
const provider = () => ({
  getEmailBody: (id: string) => getEmailBodyFromServer(id),
  getEmailMetadata: (id: string) => getEmailMetadata(id),
  downloadBlob: (b: string, t: string, n: string) => downloadBlob(b, t, n),
})
let mailProvider: unknown = provider()

vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ mail: mailProvider }),
}))

const { downloadOriginal, getAttachmentText, getEmailBody, getMessageMetadata } =
  await import('./mail')

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
  downloadBlob.mockImplementation(async () => new Blob(['BEGIN:VCALENDAR']))
  mailProvider = provider()
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

describe('saving the original message', () => {
  // These stub document.createElement and URL for the whole document; leaving
  // either in place would quietly break every test that runs after.
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** What the browser was handed to save, and what was cleaned up after. */
  function watchDownloads() {
    const created: Blob[] = []
    const revoked: string[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => {
        created.push(b)
        return `blob:${created.length}`
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    })
    const anchor = document.createElement('a')
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => {})
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    return { anchor, click, created, revoked }
  }

  it('hands over an .eml under the name the message was given', async () => {
    /*
     * `download` is what makes the browser save rather than navigate, and
     * message/rfc822 is what the file has to be asked for as — the whole point
     * is the bytes the server holds, not the app's model of them.
     */
    const { anchor, click } = watchDownloads()

    await expect(downloadOriginal(ACC, 'b1', 'Rechnung.eml')).resolves.toBe(true)

    expect(downloadBlob).toHaveBeenCalledWith('b1', 'message/rfc822', 'Rechnung.eml')
    expect(anchor.download).toBe('Rechnung.eml')
    expect(click).toHaveBeenCalled()
  })

  it('releases the object URL later rather than straight after the click', async () => {
    /*
     * Revoking it in the same turn races the download the click started: some
     * browsers have not read the blob yet and the file arrives empty. Leaving
     * it forever leaks the whole message, so it goes on a timer.
     */
    vi.useFakeTimers()
    try {
      const { revoked } = watchDownloads()

      await downloadOriginal(ACC, 'b1', 'Rechnung.eml')
      expect(revoked).toEqual([])

      vi.runAllTimers()
      expect(revoked).toEqual(['blob:1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports failure rather than throwing without a mail provider', async () => {
    mailProvider = null
    await expect(downloadOriginal(ACC, 'b1', 'x.eml')).resolves.toBe(false)
  })
})

describe('reading an attachment as text', () => {
  it('asks for it under its own type, not as a message', async () => {
    // This is how the invitation in an iMIP mail is read; asking for
    // message/rfc822 would hand back the enclosing mail instead.
    await expect(getAttachmentText(ACC, 'b1', 'text/calendar', 'invite.ics')).resolves.toBe(
      'BEGIN:VCALENDAR',
    )

    expect(downloadBlob).toHaveBeenCalledWith('b1', 'text/calendar', 'invite.ics')
    // Not cached: it is read once while the message is open.
    expect(await db.bodyCache.where('accountId').equals(ACC).count()).toBe(0)
  })

  it('is null without a mail provider', async () => {
    mailProvider = null
    await expect(getAttachmentText(ACC, 'b1', 'text/calendar', 'invite.ics')).resolves.toBeNull()
  })
})
