import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StorageQuota } from '../../domain/quota'
import { FIRST_READ_MS } from './quota'

const GIB = 1_073_741_824

let reported: StorageQuota | null = null
let failing = false
const read = vi.fn(() =>
  failing ? Promise.reject(new Error('unreachable')) : Promise.resolve(reported),
)
vi.mock('../../services/quota', () => ({ storageQuota: () => read() }))

const open = vi.fn()
vi.mock('./navigation', () => ({ useSettingsRoute: () => ({ open }) }))

const { StorageSetting, StorageWarning } = await import('./StorageQuota')

afterEach(() => {
  cleanup()
  read.mockClear()
  failing = false
  vi.useRealTimers()
})

/** The header defers its first read, so nothing happens on real time alone. */
async function afterFirstRead() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS)
  })
}

describe('the warning in the shell header', () => {
  // The whole point of putting it there: chrome that every screen carries
  // stays quiet until the number is worth acting on.
  it('says nothing while there is room left', async () => {
    vi.useFakeTimers()
    reported = { used: GIB * 0.12, limit: GIB }
    render(<StorageWarning accountId="acc" enabled />)
    await afterFirstRead()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('appears once storage is nearly gone', async () => {
    vi.useFakeTimers()
    reported = { used: GIB * 0.94, limit: GIB }
    render(<StorageWarning accountId="acc" enabled />)
    await afterFirstRead()
    expect(screen.getByRole('button', { name: /Storage almost full/ })).toHaveTextContent('94 %')
  })

  // The startup burst is the reason for the delay; asking inside it is the bug
  // this guards against.
  it('asks nothing until the startup burst has passed', async () => {
    vi.useFakeTimers()
    reported = { used: GIB * 0.94, limit: GIB }
    render(<StorageWarning accountId="acc" enabled />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FIRST_READ_MS - 1)
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('stays away when the server offers no quota at all', async () => {
    vi.useFakeTimers()
    reported = null
    render(<StorageWarning accountId="acc" enabled />)
    await afterFirstRead()
    expect(screen.queryByRole('button')).toBeNull()
  })

  // Asking a server that never answers would be one failed request per render.
  it('does not ask a server without the capability', async () => {
    vi.useFakeTimers()
    reported = { used: GIB * 0.94, limit: GIB }
    render(<StorageWarning accountId="acc" enabled={false} />)
    await afterFirstRead()
    expect(read).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the figure in settings', () => {
  it('names both numbers whatever the level', async () => {
    reported = { used: 127_106, limit: GIB }
    render(<StorageSetting accountId="acc" enabled />)
    expect(await screen.findByText(/124 KB of 1\.0 GB used/)).toBeInTheDocument()
  })

  // "Not read yet" and "nothing limits this account" are opposite claims, and
  // rendering the second while the first is true says something false.
  it('does not claim there is no limit while still asking', () => {
    reported = { used: 127_106, limit: GIB }
    render(<StorageSetting accountId="acc" enabled />)
    expect(screen.queryByText(/sets no storage limit/)).toBeNull()
  })

  // A blip is not an answer: reporting "no limit" because one request failed
  // states the opposite of what is known, and it would stand until the next
  // slow refresh.
  it('does not turn a failed read into "no limit"', async () => {
    vi.useFakeTimers()
    failing = true
    render(<StorageSetting accountId="acc" enabled />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(read).toHaveBeenCalled()
    expect(screen.queryByText(/sets no storage limit/)).toBeNull()
  })

  it('says so when nothing limits the account', async () => {
    reported = null
    render(<StorageSetting accountId="acc" enabled />)
    expect(await screen.findByText(/sets no storage limit/)).toBeInTheDocument()
  })
})
