import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Credentials } from '../../domain/account'

/** The session document the server is pretending to serve. */
let session: Record<string, unknown>

vi.mock('./client/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client/session')>()),
  fetchSession: (sessionUrl: string) =>
    Promise.resolve({
      sessionUrl,
      apiUrl: 'https://jmap.test/api',
      uploadUrl: 'https://jmap.test/upload/{accountId}',
      downloadUrl: 'https://jmap.test/download/{accountId}/{blobId}',
      eventSourceUrl: 'https://jmap.test/events',
      session,
    }),
}))

const { jmapProvider } = await import('./index')

const creds: Credentials = { method: 'basic', username: 'alice@example.test', secret: 'pw' }

/** A session offering exactly the named capabilities on its one account. */
function sessionWith(accountCapabilities: string[], over: Record<string, unknown> = {}) {
  return {
    username: 'alice@example.test',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
    capabilities: { 'urn:ietf:params:jmap:core': {} },
    accounts: {
      a1: {
        name: 'alice@example.test',
        accountCapabilities: Object.fromEntries(accountCapabilities.map((c) => [c, {}])),
      },
    },
    ...over,
  }
}

const MAIL = 'urn:ietf:params:jmap:mail'
const CONTACTS = 'urn:ietf:params:jmap:contacts'
const CALENDARS = 'urn:ietf:params:jmap:calendars'

beforeEach(() => {
  session = sessionWith([MAIL, CONTACTS, CALENDARS])
})

describe('opening a connection to a JMAP server', () => {
  it('builds only the providers the account actually offers', async () => {
    /*
     * A server may carry mail and nothing else. Creating the other providers
     * anyway means every contacts and calendar sync fires requests the server
     * answers with unknownCapability — and the tabs offer features that
     * cannot work.
     */
    session = sessionWith([MAIL])

    const conn = await jmapProvider.connect('https://example.test', creds, 'local-1')

    expect(conn.mail).not.toBeNull()
    expect(conn.contacts).toBeNull()
    expect(conn.calendars).toBeNull()
    expect(conn.capabilities).toMatchObject({ mail: true, contacts: false, calendars: false })
  })

  it('builds all three when the account has all three', async () => {
    const conn = await jmapProvider.connect('https://example.test', creds, 'local-1')

    expect(conn.mail).not.toBeNull()
    expect(conn.contacts).not.toBeNull()
    expect(conn.calendars).not.toBeNull()
  })

  it('keeps the local id rather than the server’s account id', async () => {
    /*
     * Every row in IndexedDB is keyed by the local id, and the same server
     * account may be added twice. The server's id lives on as
     * remoteAccountId, which is what the requests carry.
     */
    const conn = await jmapProvider.connect('https://example.test', creds, 'local-1')

    expect(conn.account.id).toBe('local-1')
    expect(conn.account.remoteAccountId).toBe('a1')
  })

  it('stores the resolved session URL, not what was typed into the form', async () => {
    // Reopening the account must not redo the autodiscovery walk, so what is
    // kept is the URL that answered.
    const conn = await jmapProvider.connect('https://example.test', creds, 'local-1')

    expect(conn.account.sessionUrl).toBe('https://example.test/.well-known/jmap')
  })

  it('refuses a server with no mail account to work with', async () => {
    // Without a primary account there is nothing to address any request to,
    // and the login form has a message for exactly this.
    session = sessionWith([MAIL], { primaryAccounts: {}, accounts: {} })

    await expect(jmapProvider.connect('https://example.test', creds, 'local-1')).rejects.toThrow()
  })

  it('labels the account by what the server calls the user', async () => {
    const conn = await jmapProvider.connect('https://example.test', creds, 'local-1')
    expect(conn.account.label).toBe('alice@example.test')
  })

  it('falls back to the typed username, then to the account id', async () => {
    // Some servers send no username at all; an empty label leaves the account
    // switcher showing a blank row.
    session = sessionWith([MAIL], { username: '' })
    const withCreds = await jmapProvider.connect('https://example.test', creds, 'local-1')
    expect(withCreds.account.label).toBe('alice@example.test')

    session = sessionWith([MAIL], { username: '' })
    const bearer = await jmapProvider.connect(
      'https://example.test',
      {
        method: 'bearer',
        secret: 'token',
      } as Credentials,
      'local-1',
    )
    expect(bearer.account.label).toBe('a1')
  })

  it('carries the push endpoint and the credentials it needs', async () => {
    // The EventSource connection is opened outside the transport and has to
    // authenticate itself.
    const conn = await jmapProvider.connect('https://example.test', creds, 'local-1')

    expect(conn.push).toEqual({
      eventSourceUrl: 'https://jmap.test/events',
      credentials: creds,
    })
  })
})

describe('reopening a stored account', () => {
  it('goes straight to the session URL it kept, without rediscovering', async () => {
    /*
     * Autodiscovery is a walk over several candidate hosts. Repeating it on
     * every app start would add that walk to the critical path of seeing any
     * mail at all.
     */
    const account = {
      id: 'local-9',
      provider: 'jmap' as const,
      sessionUrl: 'https://mail.example.test/.well-known/jmap',
    }

    const conn = await jmapProvider.open(account as never, creds)

    expect(conn.account.sessionUrl).toBe('https://mail.example.test/.well-known/jmap')
    expect(conn.account.id).toBe('local-9')
  })
})
