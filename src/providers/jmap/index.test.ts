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
const FILENODE = 'urn:ietf:params:jmap:filenode'

beforeEach(() => {
  session = sessionWith([MAIL, CONTACTS, CALENDARS])
})

const URL = 'https://example.test/.well-known/jmap'

/** The session's first account, as the local account `local-1` of session `s-1`. */
async function connect(c: Credentials = creds) {
  const opened = await jmapProvider.openSession(URL, c, 's-1')
  return opened.account('s-1', 'local-1', opened.accounts[0]!)
}

describe('opening a connection to a JMAP server', () => {
  it('builds only the providers the account actually offers', async () => {
    /*
     * A server may carry mail and nothing else. Creating the other providers
     * anyway means every contacts and calendar sync fires requests the server
     * answers with unknownCapability — and the tabs offer features that
     * cannot work.
     */
    session = sessionWith([MAIL])

    const conn = await connect()

    expect(conn.mail).not.toBeNull()
    expect(conn.contacts).toBeNull()
    expect(conn.calendars).toBeNull()
    expect(conn.capabilities).toMatchObject({ mail: true, contacts: false, calendars: false })
  })

  it('builds all three when the account has all three', async () => {
    const conn = await connect()

    expect(conn.mail).not.toBeNull()
    expect(conn.contacts).not.toBeNull()
    expect(conn.calendars).not.toBeNull()
  })

  it('leaves out file storage unless the account offers the draft extension', async () => {
    // FileNode is an unfinished draft that most servers do not implement.
    const without = await connect()
    expect(without.files).toBeNull()
    expect(without.capabilities.files).toBe(false)

    session = sessionWith([MAIL, FILENODE])
    const conn = await connect()
    expect(conn.files).not.toBeNull()
    expect(conn.capabilities.files).toBe(true)
  })

  it('keeps the local ids rather than the server’s account id', async () => {
    /*
     * Every row in IndexedDB is keyed by the local id, and the same server
     * account may be added twice. The server's id lives on as
     * remoteAccountId, which is what the requests carry.
     */
    const conn = await connect()

    expect(conn.account.id).toBe('local-1')
    expect(conn.account.sessionId).toBe('s-1')
    expect(conn.account.remoteAccountId).toBe('a1')
  })

  it('keeps the session URL it was opened with, without rediscovering', async () => {
    /*
     * Autodiscovery is a walk over several candidate hosts. Repeating it on
     * every app start would add that walk to the critical path of seeing any
     * mail at all.
     */
    const opened = await jmapProvider.openSession('https://mail.example.test/jmap', creds, 's-1')

    expect(opened.session.sessionUrl).toBe('https://mail.example.test/jmap')
    expect(opened.account('s-1', 'local-1', 'a1').account.sessionUrl).toBe(
      'https://mail.example.test/jmap',
    )
  })

  it('refuses a server with no mail account to work with', async () => {
    // Without a primary account there is nothing to address any request to,
    // and the login form has a message for exactly this.
    session = sessionWith([MAIL], { primaryAccounts: {}, accounts: {} })

    await expect(jmapProvider.openSession(URL, creds, 's-1')).rejects.toThrow()
  })

  it('labels the account by its own name, and the session by the user', async () => {
    const opened = await jmapProvider.openSession(URL, creds, 's-1')
    expect(opened.session.label).toBe('alice@example.test')
    expect(opened.account('s-1', 'local-1', 'a1').account.label).toBe('alice@example.test')
  })

  it('falls back to the username, then the typed one, then the account id', async () => {
    // Some servers send no names at all; an empty label leaves the account
    // switcher showing a blank row.
    const nameless = { a1: { name: '', accountCapabilities: { [MAIL]: {} } } }
    session = sessionWith([MAIL], { accounts: nameless })
    expect((await connect()).account.label).toBe('alice@example.test')

    session = sessionWith([MAIL], { username: '', accounts: nameless })
    expect((await connect()).account.label).toBe('alice@example.test')

    session = sessionWith([MAIL], { username: '', accounts: nameless })
    const bearer = await connect({ method: 'bearer', secret: 'token' } as Credentials)
    expect(bearer.account.label).toBe('a1')
  })

  it('carries the push endpoint and the credentials it needs', async () => {
    // The EventSource connection is opened outside the transport and has to
    // authenticate itself.
    const conn = await connect()

    expect(conn.push).toEqual({
      eventSourceUrl: 'https://jmap.test/events',
      credentials: creds,
    })
  })
})

describe('a session reaching several accounts', () => {
  beforeEach(() => {
    session = sessionWith([MAIL], {
      primaryAccounts: { [MAIL]: 'a2' },
      accounts: {
        a1: { name: 'shared@example.test', accountCapabilities: { [MAIL]: {} } },
        a2: { name: 'alice@example.test', accountCapabilities: { [MAIL]: {} } },
        c1: { name: 'calendars only', accountCapabilities: { [CALENDARS]: {} } },
      },
    })
  })

  it('lists every account with mail, the primary first', async () => {
    const opened = await jmapProvider.openSession(URL, creds, 's-1')
    expect(opened.accounts).toEqual(['a2', 'a1'])
  })

  it('gives each its own name and its own capabilities, over one set of credentials', async () => {
    const opened = await jmapProvider.openSession(URL, creds, 's-1')
    const shared = opened.account('s-1', 'local-2', 'a1')

    expect(shared.account).toMatchObject({ label: 'shared@example.test', remoteAccountId: 'a1' })
    expect(shared.push?.credentials).toBe(opened.account('s-1', 'local-1', 'a2').push?.credentials)
  })

  it('refuses one the session does not list', async () => {
    const opened = await jmapProvider.openSession(URL, creds, 's-1')
    expect(() => opened.account('s-1', 'local-3', 'c1')).toThrow()
  })
})
