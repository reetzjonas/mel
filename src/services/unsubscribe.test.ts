import { afterEach, describe, expect, it, vi } from 'vitest'
import { oneClickUnsubscribe } from './unsubscribe'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

afterEach(() => fetchMock.mockReset())

describe('oneClickUnsubscribe', () => {
  it('posts exactly what RFC 8058 says, and nothing about the reader', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))

    await expect(oneClickUnsubscribe('https://list.example/u?id=42')).resolves.toBe(true)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://list.example/u?id=42')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('List-Unsubscribe=One-Click')
    // no-cors keeps it a "simple request", so the sender's server need not
    // answer a preflight it has no reason to answer.
    expect(init.mode).toBe('no-cors')
    // The URL the sender chose already identifies the reader; nothing else
    // about them is theirs to learn.
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
  })

  it('refuses plain http, which would carry the address in the clear', async () => {
    await expect(oneClickUnsubscribe('http://list.example/u')).resolves.toBe(false)
    await expect(oneClickUnsubscribe('mailto:stop@example.com')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a request that never left rather than throwing at the caller', async () => {
    // Offline, DNS failure, a server that is simply gone. The bar offers the
    // page to open by hand next, so this has to come back as a plain false.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(oneClickUnsubscribe('https://list.example/u')).resolves.toBe(false)
  })

  it('says sent, not honoured — an opaque answer is all there is', async () => {
    // `no-cors` yields an opaque response: status 0, unreadable. Treating
    // that as failure would be as wrong as treating it as success; what we
    // can honestly report is that the request went out.
    fetchMock.mockResolvedValue(Response.error())
    await expect(oneClickUnsubscribe('https://list.example/u')).resolves.toBe(true)
  })
})
