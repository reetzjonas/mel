import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUi } from './store'

const ui = () => useUi.getState()

beforeEach(() => {
  useUi.setState({ selection: [], selectionMailboxId: null, snackbar: null, compose: null })
})

describe('selecting rows in a folder', () => {
  it('remembers which folder the selection belongs to', () => {
    // Every bulk action takes the selection *and* the folder: ids alone would
    // act on messages the list is not even showing.
    ui().toggleSelected('inbox', 'm1')
    expect(ui()).toMatchObject({ selection: ['m1'], selectionMailboxId: 'inbox' })
  })

  it('starts over when the selection moves to another folder', () => {
    ui().toggleSelected('inbox', 'm1')
    ui().toggleSelected('archive', 'm2')
    expect(ui()).toMatchObject({ selection: ['m2'], selectionMailboxId: 'archive' })
  })

  it('takes a whole conversation in or out as one thing', () => {
    /*
     * A conversation row is one thing to click. Half-selected counts as not
     * selected, so clicking it takes the whole row in rather than toggling
     * each message apart and leaving the row in a state nobody asked for.
     */
    ui().toggleSelected('inbox', ['m1', 'm2', 'm3'])
    expect(ui().selection).toEqual(['m1', 'm2', 'm3'])

    ui().toggleSelected('inbox', ['m1', 'm2', 'm3'])
    expect(ui().selection).toEqual([])
  })

  it('adds the rest of a partly selected row rather than dropping what was there', () => {
    ui().toggleSelected('inbox', 'm1')
    ui().toggleSelected('inbox', ['m1', 'm2'])
    expect(ui().selection).toEqual(['m1', 'm2'])
  })

  it('never lists the same message twice', () => {
    ui().toggleSelected('inbox', ['m1', 'm2'])
    ui().toggleSelected('inbox', ['m2', 'm3'])
    expect([...ui().selection].sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('forgets the folder once nothing is selected any more', () => {
    // A folder left behind on an empty selection would make the toolbar
    // believe a selection exists in a folder that has none.
    ui().toggleSelected('inbox', 'm1')
    ui().toggleSelected('inbox', 'm1')
    expect(ui()).toMatchObject({ selection: [], selectionMailboxId: null })
  })

  it('does the same for select-all and for clearing', () => {
    ui().setSelection('inbox', ['m1', 'm2'])
    expect(ui()).toMatchObject({ selection: ['m1', 'm2'], selectionMailboxId: 'inbox' })

    ui().setSelection('inbox', [])
    expect(ui().selectionMailboxId).toBeNull()

    ui().setSelection('inbox', ['m1'])
    ui().clearSelection()
    expect(ui()).toMatchObject({ selection: [], selectionMailboxId: null })
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
