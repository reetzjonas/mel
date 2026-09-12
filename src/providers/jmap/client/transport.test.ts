import { afterEach, describe, expect, it, vi } from 'vitest'
import { JmapError, authHeader, createTransport } from './transport'

const creds = { method: 'basic', username: 'alice@example.test', secret: 'pw' } as const

afterEach(() => vi.unstubAllGlobals())

describe('authHeader', () => {
  it('builds each scheme the way its server expects', () => {
    expect(authHeader(creds)).toBe(`Basic ${btoa('alice@example.test:pw')}`)
    expect(authHeader({ method: 'bearer', secret: 'token-123' })).toBe('Bearer token-123')
  })

  it('still sends a well-formed header without a username', () => {
    // Some servers take the token in the password field alone; a header
    // missing the colon would be rejected as malformed rather than as wrong.
    expect(authHeader({ method: 'basic', secret: 'pw' })).toBe(`Basic ${btoa(':pw')}`)
  })
})

describe('what counts as worth retrying', () => {
  /*
   * The outbox backs off and retries on `transient` and gives up loudly on
   * anything else. Getting this wrong either drops a user's action silently
   * or hammers a server that has already said no.
   */
  it('retries what may pass, and not what will not', () => {
    const kinds = ['network', 'server', 'ratelimit'] as const
    for (const kind of kinds) expect(new JmapError('x', kind).transient).toBe(true)
    for (const kind of ['auth', 'protocol'] as const)
      expect(new JmapError('x', kind).transient).toBe(false)
  })
})

/** A transport whose fetch answers with whatever the test hands it. */
function transportAnswering(res: Response | (() => never)) {
  const fetchMock = vi.fn(async () => (typeof res === 'function' ? res() : res))
  vi.stubGlobal('fetch', fetchMock)
  return { transport: createTransport('https://mail.example.test/jmap/', creds), fetchMock }
}

describe('how a failed request is classified', () => {
  const problem = (status: number, body?: unknown, headers?: HeadersInit) =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status, headers })

  it('separates a refused password from a broken server from a bad request', () => {
    // The sync bar says something different for each of these, and the outbox
    // only retries some of them.
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'ratelimit'],
      [500, 'server'],
      [503, 'server'],
      [400, 'protocol'],
      [404, 'protocol'],
    ]
    return Promise.all(
      cases.map(async ([status, kind]) => {
        const { transport } = transportAnswering(problem(status))
        await expect(transport.request({} as never)).rejects.toMatchObject({ kind, status })
      }),
    )
  })

  it('prefers the server’s own explanation over a bare status', async () => {
    const { transport } = transportAnswering(
      problem(400, { type: 'urn:ietf:params:jmap:error:limit', detail: 'Too many calls' }),
    )
    await expect(transport.request({} as never)).rejects.toThrow('Too many calls')
  })

  it('survives an error body that is not JSON at all', async () => {
    // nginx and friends answer with HTML; that must not turn a 503 into a
    // parse error nobody can act on.
    const { transport } = transportAnswering(problem(503, undefined))
    await expect(transport.request({} as never)).rejects.toMatchObject({
      kind: 'server',
      status: 503,
    })
  })

  it('waits as long as a rate limit asks, or half a minute if it does not say', async () => {
    const { transport } = transportAnswering(problem(429, undefined, { 'Retry-After': '120' }))
    await expect(transport.request({} as never)).rejects.toMatchObject({
      retryAfterMs: 120_000,
    })

    const { transport: bare } = transportAnswering(problem(429))
    await expect(bare.request({} as never)).rejects.toMatchObject({ retryAfterMs: 30_000 })
  })

  it('reports a connection that never got an answer as network', async () => {
    // CORS rejections and DNS failures arrive as a thrown TypeError with no
    // status — indistinguishable to the browser, and both worth retrying.
    const { transport } = transportAnswering(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = await transport.request({} as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JmapError)
    expect(err).toMatchObject({ kind: 'network' })
    expect((err as JmapError).transient).toBe(true)
  })
})

describe('a successful request', () => {
  it('posts the batch as JSON, authorised, and hands back the parsed answer', async () => {
    const body = { methodResponses: [['Email/get', { list: [] }, 'c0']], sessionState: 's' }
    const { transport, fetchMock } = transportAnswering(
      new Response(JSON.stringify(body), { status: 200 }),
    )

    await expect(transport.request({ using: [], methodCalls: [] } as never)).resolves.toEqual(body)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mail.example.test/jmap/')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Authorization']).toBe(authHeader(creds))
  })
})
