import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailHeader } from '../domain/email'
import { db } from '../storage/db'
import { toEmailRow } from '../storage/emailRow'

let found: { ids: string[]; snippets: Record<string, unknown> } = { ids: [], snippets: {} }
const searchOnServer = vi.fn(async () => found)
const getEmailHeaders = vi.fn(async (ids: string[]) => ids.map((id) => header(id)))
let mailProvider: unknown

vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ mail: mailProvider }),
}))

const { searchEmails } = await import('./search')

const ACC = 'acc'

function header(id: string): EmailHeader {
  return {
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [],
    to: [],
    cc: [],
    subject: id,
    preview: '',
    receivedAt: '2026-09-09T10:00:00Z',
    hasAttachment: false,
    attachments: [],
  } as unknown as EmailHeader
}

beforeEach(async () => {
  vi.clearAllMocks()
  found = { ids: [], snippets: {} }
  mailProvider = {
    searchEmails: () => searchOnServer(),
    getEmailHeaders: (ids: string[]) => getEmailHeaders(ids),
  }
  await db.emails.where('accountId').equals(ACC).delete()
})

describe('searching', () => {
  it('does not ask the server for something that is not a query', async () => {
    // An empty box is not a search; sending it would return the mailbox.
    await expect(searchEmails(ACC, '')).resolves.toBeNull()
    await expect(searchEmails(ACC, '   ')).resolves.toBeNull()
    expect(searchOnServer).not.toHaveBeenCalled()
  })

  it('keeps the server’s order, which is what relevance means here', async () => {
    /*
     * The server ranks the hits. Rebuilding the list from a local lookup in
     * any other order would quietly replace its ranking with ours.
     */
    found = { ids: ['c', 'a', 'b'], snippets: {} }
    for (const id of ['a', 'b', 'c']) await db.emails.put(toEmailRow(ACC, header(id)))

    const result = await searchEmails(ACC, 'rechnung')

    expect(result!.headers.map((h) => h.id)).toEqual(['c', 'a', 'b'])
  })

  it('answers from what is already stored, without refetching it', async () => {
    found = { ids: ['a'], snippets: {} }
    await db.emails.put(toEmailRow(ACC, header('a')))

    await searchEmails(ACC, 'rechnung')

    expect(getEmailHeaders).not.toHaveBeenCalled()
  })

  it('fetches only the hits it does not have yet', async () => {
    // A hit can be a message outside the synced window — older than anything
    // the list has loaded — and the result must still show it.
    found = { ids: ['have', 'missing'], snippets: {} }
    await db.emails.put(toEmailRow(ACC, header('have')))

    const result = await searchEmails(ACC, 'rechnung')

    expect(getEmailHeaders).toHaveBeenCalledWith(['missing'])
    expect(result!.headers.map((h) => h.id)).toEqual(['have', 'missing'])
  })

  it('stores what it had to fetch, so the cache warms up as you search', async () => {
    found = { ids: ['missing'], snippets: {} }

    await searchEmails(ACC, 'rechnung')

    expect(await db.emails.get([ACC, 'missing'])).toBeDefined()
  })

  it('passes the snippets through untouched', async () => {
    // The server marks the matched words; the list renders that verbatim.
    found = {
      ids: ['a'],
      snippets: { a: { subject: 'Re: <mark>Rechnung</mark>', preview: null } },
    }
    await db.emails.put(toEmailRow(ACC, header('a')))

    const result = await searchEmails(ACC, 'rechnung')

    expect(result!.snippets['a']).toEqual({ subject: 'Re: <mark>Rechnung</mark>', preview: null })
  })

  it('answers with nothing found rather than null when the query was real', async () => {
    // Null means "no search happened" and leaves the mailbox on screen; an
    // empty result has to say "no results" instead.
    found = { ids: [], snippets: {} }

    await expect(searchEmails(ACC, 'nothing-matches')).resolves.toEqual({
      headers: [],
      snippets: {},
    })
  })

  it('is null on a server that offers no mail', async () => {
    mailProvider = null
    await expect(searchEmails(ACC, 'rechnung')).resolves.toBeNull()
  })
})
