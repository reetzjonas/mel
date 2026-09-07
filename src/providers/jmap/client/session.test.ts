import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoveryCandidates, sessionUrlFor, srvCandidates } from './session'

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
    expect(discoveryCandidates('alice@localhost')[0]).toBe(
      'http://localhost:8080/.well-known/jmap',
    )
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
    expect(await srvCandidates('you@reetz.me')).toEqual([
      'https://mail.reetz.me/.well-known/jmap',
    ])
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
