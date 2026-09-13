import { describe, expect, it, vi } from 'vitest'
import { createJmapSieve, isActiveScript, isSyntaxError } from './sieve'
import type { Transport } from './client/transport'
import type { Invocation, JmapRequest } from './client/types/core'

const UPLOAD = 'https://example.test/upload/{accountId}/'
const DOWNLOAD = 'https://example.test/download/{accountId}/{blobId}/{name}?accept={type}'

function serverAnswering(byName: Record<string, unknown>, uploadBlobId = 'uploaded') {
  const sent: JmapRequest[] = []
  const uploads: Array<{ url: string; type: unknown; body: unknown }> = []
  const fetchRaw = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      uploads.push({
        url,
        type: (init.headers as Record<string, string> | undefined)?.['Content-Type'],
        body: init.body,
      })
    return Promise.resolve({
      json: () => Promise.resolve({ blobId: uploadBlobId }),
      text: () => Promise.resolve('require ["fileinto"];\r\n'),
    } as unknown as Response)
  })
  const transport = {
    request: (req: JmapRequest) => {
      sent.push(req)
      const responses: Invocation[] = req.methodCalls.map(([name, , callId]) => [
        name,
        (byName[name] ?? {}) as never,
        callId,
      ])
      return Promise.resolve({ methodResponses: responses, sessionState: 's' })
    },
    fetchRaw,
  } as unknown as Transport
  return {
    provider: createJmapSieve(transport, 'acc', UPLOAD, DOWNLOAD),
    sent,
    uploads,
    fetchRaw,
  }
}

describe('classifying what the server refused', () => {
  it('reads a syntax error under either name', () => {
    /*
     * RFC 9661 registers `invalidSieve`; Stalwart answers `invalidScript` for
     * the same condition. Matching only the registered spelling turns a
     * reported syntax error into "something went wrong" on the one server
     * this app is actually tested against.
     */
    expect(isSyntaxError({ type: 'invalidSieve', permanent: true })).toBe(true)
    expect(isSyntaxError({ type: 'invalidScript', permanent: true })).toBe(true)
    expect(isSyntaxError({ type: 'forbidden', permanent: true })).toBe(false)
  })

  it('reads "this one is active" under either name', () => {
    expect(isActiveScript({ type: 'sieveIsActive', permanent: true })).toBe(true)
    expect(isActiveScript({ type: 'scriptIsActive', permanent: true })).toBe(true)
    expect(isActiveScript({ type: 'notFound', permanent: true })).toBe(false)
  })
})

describe('listing and reading scripts', () => {
  it('reports which one is active', async () => {
    const { provider } = serverAnswering({
      'SieveScript/get': {
        list: [
          { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
          { id: 's2', name: 'old', blobId: 'b2' },
        ],
        state: 's',
      },
    })

    const scripts = await provider.listScripts()

    expect(scripts).toEqual([
      { id: 's1', name: 'filters', blobId: 'b1', isActive: true },
      { id: 's2', name: 'old', blobId: 'b2', isActive: false },
    ])
  })

  it('downloads the blob the script carries, not one an upload returned', async () => {
    // The server re-addresses uploaded content, so the id that came back from
    // the upload does not resolve afterwards.
    const { provider, fetchRaw } = serverAnswering({})

    await provider.readScript({ id: 's1', name: 'filters', blobId: 'stored', isActive: true })

    expect(fetchRaw.mock.calls[0]![0]).toContain('/download/acc/stored/filters')
  })

  it('has nothing to fetch for a script with no blob', async () => {
    const { provider, fetchRaw } = serverAnswering({})

    expect(await provider.readScript({ id: 's1', name: 'x', blobId: '', isActive: false })).toBe('')
    expect(fetchRaw).not.toHaveBeenCalled()
  })
})

describe('validating', () => {
  it('uploads the text as a sieve blob and asks about that', async () => {
    // validate takes a blob id, never inline text, so checking a script
    // always costs an upload first.
    const { provider, sent, uploads } = serverAnswering(
      { 'SieveScript/validate': { error: null } },
      'fresh',
    )

    expect(await provider.validate('require ["fileinto"];')).toBeNull()
    expect(uploads[0]!.type).toBe('application/sieve')
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ blobId: 'fresh' })
  })

  it('hands back the message naming the line, not the error type', async () => {
    const { provider } = serverAnswering({
      'SieveScript/validate': {
        error: { type: 'invalidScript', description: 'Expected token at line 1, column 30.' },
      },
    })

    expect(await provider.validate('bogus')).toBe('Expected token at line 1, column 30.')
  })

  it('falls back to the type when the server explains nothing', async () => {
    const { provider } = serverAnswering({
      'SieveScript/validate': { error: { type: 'invalidScript' } },
    })

    expect(await provider.validate('bogus')).toBe('invalidScript')
  })
})

describe('saving', () => {
  it('creates a script and can activate it in the same call', async () => {
    const { provider, sent } = serverAnswering(
      { 'SieveScript/set': { created: { s0: { id: 'new' } } } },
      'blob-1',
    )

    await expect(
      provider.saveScript({ name: 'filters', content: 'x', activate: true }),
    ).resolves.toEqual({ id: 'new', failure: null })
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({
      create: { s0: { name: 'filters', blobId: 'blob-1' } },
      // The creation reference, since the id does not exist yet.
      onSuccessActivateScript: '#s0',
    })
  })

  it('updates an existing script by its id', async () => {
    const { provider, sent } = serverAnswering(
      { 'SieveScript/set': { updated: { s1: null } } },
      'blob-2',
    )

    await expect(
      provider.saveScript({ id: 's1', name: 'filters', content: 'x', activate: true }),
    ).resolves.toEqual({ id: 's1', failure: null })
    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({
      update: { s1: { name: 'filters', blobId: 'blob-2' } },
      onSuccessActivateScript: 's1',
    })
  })

  it('leaves activation alone unless asked', async () => {
    const { provider, sent } = serverAnswering({
      'SieveScript/set': { created: { s0: { id: 'new' } } },
    })

    await provider.saveScript({ name: 'filters', content: 'x' })

    expect(sent[0]!.methodCalls[0]![1]).not.toHaveProperty('onSuccessActivateScript')
  })

  it('reports a script the server would not parse, as permanent', async () => {
    const { provider } = serverAnswering({
      'SieveScript/set': {
        notCreated: { s0: { type: 'invalidScript', description: 'line 1' } },
      },
    })

    const { id, failure } = await provider.saveScript({ name: 'x', content: 'bogus' })

    expect(id).toBeNull()
    expect(failure).toMatchObject({ type: 'invalidScript', permanent: true })
  })
})

describe('activating and removing', () => {
  it('switches filtering off with the deactivate argument, not an id', async () => {
    const { provider, sent } = serverAnswering({ 'SieveScript/set': {} })

    expect(await provider.setActive(null)).toBeNull()

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ onSuccessDeactivateScript: true })
  })

  it('activates by id', async () => {
    const { provider, sent } = serverAnswering({ 'SieveScript/set': {} })

    await provider.setActive('s1')

    expect(sent[0]!.methodCalls[0]![1]).toMatchObject({ onSuccessActivateScript: 's1' })
  })

  it('passes on the refusal to delete the active script', async () => {
    const { provider } = serverAnswering({
      'SieveScript/set': {
        notDestroyed: { s1: { type: 'scriptIsActive', description: 'Deactivate first.' } },
      },
    })

    const failure = await provider.destroyScript('s1')

    expect(failure).toMatchObject({ type: 'scriptIsActive', permanent: true })
    expect(failure && isActiveScript(failure)).toBe(true)
  })

  it('says nothing when the server took it', async () => {
    const { provider } = serverAnswering({ 'SieveScript/set': { destroyed: ['s1'] } })

    expect(await provider.destroyScript('s1')).toBeNull()
  })
})
