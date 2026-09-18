import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUi } from './store'

const ui = () => useUi.getState()

beforeEach(() => {
  useUi.setState({ mailSelectionClearSignal: 0, snackbar: null, compose: null })
})

describe('the mail selection clear signal', () => {
  it('bumps on every call, so a listening effect always sees a fresh value', () => {
    // The actual selection lives in lib/selection.ts's useSelection, local to
    // mail.$mailboxId.tsx; this is only the cross-route nudge MailboxSidebar
    // (a sibling route, not a descendant) uses to say "that one is now
    // stale" after moving a dragged selection elsewhere. A boolean would
    // miss a second clear while the first hadn't been observed yet — the
    // same reason unlockVersion above is a counter, not a flag.
    ui().clearMailSelection()
    expect(ui().mailSelectionClearSignal).toBe(1)
    ui().clearMailSelection()
    expect(ui().mailSelectionClearSignal).toBe(2)
  })
})

describe('the snackbar', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('goes away on its own', () => {
    ui().showSnackbar({ message: 'Archived' }, 5_000)
    expect(ui().snackbar).not.toBeNull()

    vi.advanceTimersByTime(5_000)
    expect(ui().snackbar).toBeNull()
  })

  it('gives a second message the full time, not the remainder of the first', () => {
    // Undo lives in here. Inheriting the previous message's countdown would
    // take the undo away early, and the action would stand.
    ui().showSnackbar({ message: 'first' }, 5_000)
    vi.advanceTimersByTime(4_000)
    ui().showSnackbar({ message: 'second' }, 5_000)

    vi.advanceTimersByTime(2_000)
    expect(ui().snackbar).toMatchObject({ message: 'second' })

    vi.advanceTimersByTime(3_500)
    expect(ui().snackbar).toBeNull()
  })

  it('stays gone when dismissed by hand', () => {
    // The timer of a dismissed message must not fire later and clear a newer
    // one that is still wanted.
    ui().showSnackbar({ message: 'first' }, 5_000)
    ui().hideSnackbar()
    ui().showSnackbar({ message: 'second' }, 10_000)

    vi.advanceTimersByTime(6_000)
    expect(ui().snackbar).toMatchObject({ message: 'second' })
  })
})
