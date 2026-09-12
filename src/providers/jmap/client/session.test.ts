import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capabilitiesFor,
  coreLimits,
  discoveryCandidates,
  fetchSession,
  primaryMailAccount,
  sessionUrlFor,
  srvCandidates,
} from './session'
import { Cap, type JmapSession } from './types/core'

describe('sessionUrlFor', () => {
  it('appends the well-known path to a bare host', () => {
    expect(sessionUrlFor('mail.example.com')).toBe('https://mail.example.com/.well-known/jmap')
  })

  it('leaves an explicit session URL alone', () => {
    expect(sessionUrlFor('https://api.example.com/jmap/session')).toBe(
      'https://api.example.com/jmap/session',
    )
    expect(sessionUrlFor('http://localhost:8080/.well-known/jmap')).toBe(
      'http://localhost:8080/.well-known/jmap',
    )
  })
})

describe('discoveryCandidates', () => {
  it('tries mail.<domain> before the apex', () => {
    // Mail-only domains frequently have no A record on the apex at all, so
    // the conventional host has to come first or discovery just times out.
    expect(discoveryCandidates('you@reetz.me')).toEqual([
      'https://mail.reetz.me/.well-known/jmap',
      'https://reetz.me/.well-known/jmap',
      'https://jmap.reetz.me/.well-known/jmap',
      'https://imap.reetz.me/.well-known/jmap',
    ])
  })

  it('uses plain http for local dev servers', () => {
    expect(discoveryCandidates('alice@localhost')[0]).toBe('http://localhost:8080/.well-known/jmap')
  })

  it('returns nothing without a domain part', () => {
    expect(discoveryCandidates('not-an-email')).toEqual([])
    expect(discoveryCandidates('')).toEqual([])
  })
})

describe('srvCandidates', () => {
  const answer = (data: string, type = 33) => ({
    ok: true,
    json: async () => ({ Answer: [{ type, data }] }),
  })

  afterEach(() => vi.unstubAllGlobals())

  it('turns an SRV record into a session URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('0 1 443 mail.reetz.me.')))
    expect(await srvCandidates('you@reetz.me')).toEqual(['https://mail.reetz.me/.well-known/jmap'])
  })

  it('keeps a non-standard port', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('0 1 8443 jmap.example.com.')))
    expect(await srvCandidates('you@example.com')).toEqual([
      'https://jmap.example.com:8443/.well-known/jmap',
    ])
  })

  it('ignores non-SRV answers and the "no service" root target', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('0 1 443 mail.example.com.', 5)))
    expect(await srvCandidates('you@example.com')).toEqual([])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('0 0 0 .')))
    expect(await srvCandidates('you@example.com')).toEqual([])
  })

  it('never queries a resolver for local addresses', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await srvCandidates('alice@localhost')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks the resolver only for the domain, never the local part', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer('0 1 443 mail.reetz.me.'))
    vi.stubGlobal('fetch', fetchMock)
    await srvCandidates('secret-name@reetz.me')
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toContain('_jmap._tcp.reetz.me')
    expect(url).not.toContain('secret-name')
  })
})

const session = (over: Partial<JmapSession> = {}): JmapSession =>
  ({
    capabilities: { [Cap.core]: {} },
    accounts: { a1: { accountCapabilities: { [Cap.mail]: {} } } },
    primaryAccounts: { [Cap.mail]: 'a1' },
    username: 'alice@example.test',
    apiUrl: '/jmap/',
    downloadUrl: '/jmap/download/{accountId}/{blobId}/{name}?type={type}',
    uploadUrl: '/jmap/upload/{accountId}/',
    eventSourceUrl: '/jmap/eventsource/?types={types}&ping={ping}',
    state: 's',
    ...over,
  }) as unknown as JmapSession

function answers(body: unknown, init: ResponseInit & { url?: string } = {}) {
  const res = new Response(JSON.stringify(body), init)
  // A well-known URL redirects to the real session endpoint, and the relative
  // URLs in the body resolve against wherever we landed — not where we asked.
  if (init.url) Object.defineProperty(res, 'url', { value: init.url })
  return res
}

describe('fetchSession', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves the session’s relative URLs against the redirect it followed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answers(session(), { url: 'https://mail.example.test/jmap/session' })),
    )

    const r = await fetchSession('https://mail.example.test/.well-known/jmap', {
      method: 'basic',
      username: 'alice',
      secret: 'pw',
    })

    expect(r.sessionUrl).toBe('https://mail.example.test/jmap/session')
    expect(r.apiUrl).toBe('https://mail.example.test/jmap/')
  })

  it('keeps RFC 6570 placeholders intact, which new URL() would escape', async () => {
    // Percent-encoded braces are not a template any more: substitution stops
    // matching and every download and upload URL silently breaks.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answers(session(), { url: 'https://mail.example.test/jmap/session' })),
    )

    const r = await fetchSession('https://mail.example.test/jmap/session', {
      method: 'bearer',
      secret: 't',
    })

    expect(r.downloadUrl).toContain('{blobId}')
    expect(r.downloadUrl).not.toContain('%7B')
    expect(r.uploadUrl).toContain('{accountId}')
    expect(r.eventSourceUrl).toContain('{types}')
  })

  it('tells apart the ways asking for a session can fail', async () => {
    // The login screen says something different for each, so flattening them
    // would send people hunting in the wrong place (see docs/notes).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )
    await expect(
      fetchSession('https://x.test/s', { method: 'basic', secret: 'p' }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    )
    await expect(
      fetchSession('https://x.test/s', { method: 'basic', secret: 'p' }),
    ).rejects.toMatchObject({ kind: 'server', status: 500, transient: true })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 400 })),
    )
    await expect(
      fetchSession('https://x.test/s', { method: 'basic', secret: 'p' }),
    ).rejects.toMatchObject({ kind: 'protocol', status: 400, transient: false })

    // A CORS rejection reaches the browser as a thrown TypeError, not a status.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(
      fetchSession('https://x.test/s', { method: 'basic', secret: 'p' }),
    ).rejects.toMatchObject({ kind: 'network' })
  })

  it('carries a throttled server’s own Retry-After, and calls it transient', async () => {
    /*
     * Stalwart's default is 1000 requests a minute, and a busy first sync can
     * reach it. This used to come back as a `protocol` error: permanent, never
     * retried, and rendered as "server unreachable" while the server was
     * answering every request and saying exactly when to come back.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '2' } })),
    )

    await expect(
      fetchSession('https://x.test/s', { method: 'basic', secret: 'p' }),
    ).rejects.toMatchObject({ kind: 'ratelimit', status: 429, retryAfterMs: 2000, transient: true })
  })

  it('falls back to a sane wait when the server sends no Retry-After', async () => {
    // The header is optional; without a wait of our own we would hammer a
    // server that has just asked us to stop.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429 })),
    )

    await expect(
      fetchSession('https://x.test/s', { method: 'basic', secret: 'p' }),
    ).rejects.toMatchObject({ kind: 'ratelimit', retryAfterMs: 30_000 })
  })
})

describe('coreLimits', () => {
  it('fills in a default for each field on its own', () => {
    // Merged per field, not `core ?? defaults`: a server that sends the
    // capability but omits one number left it undefined, and an undefined
    // chunk size produced an *empty* request that reported success — every
    // mutation in it silently dropped.
    const limits = coreLimits(session({ capabilities: { [Cap.core]: { maxObjectsInGet: 1000 } } }))
    expect(limits.maxObjectsInGet).toBe(1000)
    expect(limits.maxCallsInRequest).toBeGreaterThan(0)
    expect(limits.maxObjectsInSet).toBeGreaterThan(0)
  })

  it('refuses nonsense in place of a number', () => {
    const limits = coreLimits(
      session({
        capabilities: {
          [Cap.core]: { maxObjectsInGet: 0, maxObjectsInSet: -5, maxCallsInRequest: 'lots' },
        },
      }),
    )
    expect(limits.maxObjectsInGet).toBeGreaterThan(0)
    expect(limits.maxObjectsInSet).toBeGreaterThan(0)
    expect(limits.maxCallsInRequest).toBeGreaterThan(0)
  })

  it('works at all when the server sends no core capability', () => {
    expect(coreLimits(session({ capabilities: {} })).maxSizeUpload).toBeGreaterThan(0)
  })
})

describe('capabilitiesFor', () => {
  it('reads each feature off the account, not off the server', () => {
    // A server can speak calendars while this account has none.
    const s = session({
      accounts: {
        a1: { accountCapabilities: { [Cap.mail]: {}, [Cap.submission]: {} } },
      } as never,
    })
    expect(capabilitiesFor(s, 'a1')).toMatchObject({
      mail: true,
      submission: true,
      contacts: false,
      calendars: false,
    })
  })

  it('reports how live updates will arrive, and Web Push from the server', () => {
    expect(capabilitiesFor(session(), 'a1').push).toBe('sse')
    expect(capabilitiesFor(session({ eventSourceUrl: '' }), 'a1').push).toBe('poll')
    expect(capabilitiesFor(session(), 'a1').webPush).toBe(false)
    expect(
      capabilitiesFor(session({ capabilities: { [Cap.webpushVapid]: {} } }), 'a1').webPush,
    ).toBe(true)
  })

  it('says no to everything for an account the session does not list', () => {
    expect(capabilitiesFor(session(), 'nope')).toMatchObject({ mail: false, calendars: false })
  })
})

describe('primaryMailAccount', () => {
  it('takes what the session nominates', () => {
    expect(primaryMailAccount(session())).toBe('a1')
  })

  it('falls back to any account that can do mail', () => {
    const s = session({
      primaryAccounts: {} as never,
      accounts: {
        cal: { accountCapabilities: { [Cap.calendars]: {} } },
        box: { accountCapabilities: { [Cap.mail]: {} } },
      } as never,
    })
    expect(primaryMailAccount(s)).toBe('box')
  })

  it('is null on a server with no mail account at all', () => {
    const s = session({
      primaryAccounts: {} as never,
      accounts: { cal: { accountCapabilities: { [Cap.calendars]: {} } } } as never,
    })
    expect(primaryMailAccount(s)).toBeNull()
  })
})
