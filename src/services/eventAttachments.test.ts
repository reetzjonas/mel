import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileNode } from '../domain/file'
import { MAX_EMBEDDED_BYTES, attachmentsOf, embeddedLink } from '../lib/attachments'

const saved: Array<{ blob: Blob; name: string }> = []
vi.mock('../lib/saveBlob', () => ({
  saveBlob: (blob: Blob, name: string) => saved.push({ blob, name }),
}))

let files: Record<string, unknown> | null = null
vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ files }),
}))

const { embedFile, referenceFile, saveAttachment } = await import('./eventAttachments')

const node = (over: Partial<FileNode> = {}): FileNode =>
  ({
    id: 'n1',
    parentId: null,
    nodeType: 'file',
    name: 'plan.pdf',
    blobId: 'B1',
    type: 'application/pdf',
    size: 42,
    ...over,
  }) as FileNode

beforeEach(() => {
  saved.length = 0
  files = null
})

describe('embedFile', () => {
  it('embeds a small file with its name, type and size', async () => {
    const link = await embedFile(new File(['hello'], 'hi.txt', { type: 'text/plain' }))
    expect(link).toMatchObject({
      rel: 'enclosure',
      title: 'hi.txt',
      contentType: 'text/plain',
      size: 5,
    })
    expect(link!.href.startsWith('data:text/plain;base64,')).toBe(true)
  })

  it('falls back to a generic type', async () => {
    const link = await embedFile(new File(['x'], 'blob'))
    expect(link!.contentType).toBe('application/octet-stream')
  })

  it('refuses a file over the limit rather than bloating every sync', async () => {
    const big = new File([new Uint8Array(MAX_EMBEDDED_BYTES + 1)], 'big.bin')
    expect(await embedFile(big)).toBeNull()
  })

  it('accepts a file exactly at the limit', async () => {
    const edge = new File([new Uint8Array(MAX_EMBEDDED_BYTES)], 'edge.bin')
    expect(await embedFile(edge)).not.toBeNull()
  })
})

describe('referenceFile', () => {
  it('links to the node by blob id and download URL', async () => {
    files = { downloadHref: (n: FileNode) => `https://host/dl/${n.blobId}` }
    const link = await referenceFile('acc', node())
    expect(link).toMatchObject({
      blobId: 'B1',
      href: 'https://host/dl/B1',
      title: 'plan.pdf',
      size: 42,
    })
  })

  it('has nothing to link for an account without Files', async () => {
    expect(await referenceFile('acc', node())).toBeNull()
  })

  it('has nothing to link for a node without content', async () => {
    files = { downloadHref: () => null }
    expect(await referenceFile('acc', node({ blobId: null }))).toBeNull()
  })
})

describe('saveAttachment', () => {
  it('decodes an embedded attachment and saves it under its name', async () => {
    const [a] = attachmentsOf({
      k: embeddedLink('hi.txt', 'text/plain', new TextEncoder().encode('hello')),
    })
    expect(await saveAttachment('acc', a!)).toBe(true)
    expect(saved[0]!.name).toBe('hi.txt')
    expect(await saved[0]!.blob.text()).toBe('hello')
  })

  it('fetches a file reference by blob id', async () => {
    const readBlob = vi.fn().mockResolvedValue(new Blob(['pdf']))
    files = { readBlob }
    const [a] = attachmentsOf({
      k: {
        rel: 'enclosure',
        href: 'https://h/dl',
        blobId: 'B1',
        title: 'plan.pdf',
        contentType: 'application/pdf',
      },
    })
    expect(await saveAttachment('acc', a!)).toBe(true)
    expect(readBlob).toHaveBeenCalledWith('B1', 'application/pdf', 'plan.pdf')
    expect(saved[0]!.name).toBe('plan.pdf')
  })

  it('reports false when the file is gone, instead of throwing', async () => {
    files = { readBlob: vi.fn().mockRejectedValue(new Error('404')) }
    const [a] = attachmentsOf({ k: { rel: 'enclosure', href: 'https://h/dl', blobId: 'B1' } })
    expect(await saveAttachment('acc', a!)).toBe(false)
    expect(saved).toHaveLength(0)
  })

  it('reports false for a file reference when the account has no Files', async () => {
    const [a] = attachmentsOf({ k: { rel: 'enclosure', href: 'https://h/dl', blobId: 'B1' } })
    expect(await saveAttachment('acc', a!)).toBe(false)
  })

  it('leaves a web link to the browser', async () => {
    const [a] = attachmentsOf({ k: { rel: 'enclosure', href: 'https://example.com/a.pdf' } })
    expect(await saveAttachment('acc', a!)).toBe(false)
    expect(saved).toHaveLength(0)
  })
})
