import { afterEach, describe, expect, it, vi } from 'vitest'
import { canShareFiles, shareFile } from './webShare'

function withShare(opts: { canShare?: boolean; share?: () => Promise<void> } = {}) {
  const share = vi.fn(opts.share ?? (() => Promise.resolve()))
  const canShare = vi.fn(() => opts.canShare ?? true)
  Object.defineProperty(navigator, 'share', { configurable: true, value: share })
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare })
  return { share, canShare }
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share')
  Reflect.deleteProperty(navigator, 'canShare')
})

describe('sharing a file out of mel', () => {
  it('hands the file to the share sheet', async () => {
    const { share } = withShare()

    await expect(shareFile(new Blob(['hi'], { type: 'text/plain' }), 'note.txt')).resolves.toBe(
      true,
    )

    const shared = (share.mock.calls as unknown as Array<[{ files: File[] }]>)[0]![0]
    expect(shared.files[0]!.name).toBe('note.txt')
    expect(shared.files[0]!.type).toBe('text/plain')
  })

  it('names a type even for a blob that arrived without one', () => {
    // A share target that is handed an empty type tends to reject the file
    // outright, and the user is left with a button that does nothing.
    const { share } = withShare()

    return shareFile(new Blob(['x']), 'thing').then(() => {
      const shared = (share.mock.calls as unknown as Array<[{ files: File[] }]>)[0]![0]
      expect(shared.files[0]!.type).toBe('application/octet-stream')
    })
  })

  it('reports back when the platform turns this file down', async () => {
    // The caller saves it instead, so the button still does something.
    withShare({ canShare: false })

    await expect(shareFile(new Blob(['x']), 'thing')).resolves.toBe(false)
  })

  it('treats a dismissed sheet as handled', async () => {
    // They were shown the choice and made it. Dropping a download on them
    // afterwards is not what they asked for.
    withShare({ share: () => Promise.reject(new Error('AbortError')) })

    await expect(shareFile(new Blob(['x']), 'thing')).resolves.toBe(true)
  })

  it('offers nothing where the browser has no share sheet', async () => {
    expect(canShareFiles()).toBe(false)
    await expect(shareFile(new Blob(['x']), 'thing')).resolves.toBe(false)
  })
})
