import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useUi } from '../../app/store'
import type { Mailbox } from '../../domain/mailbox'
import { db } from '../../storage/db'
import { sealPlain } from '../../storage/envelope'
import { useMailShortcuts } from './shortcuts'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const bulkArchive = vi.fn(async () => async () => {})
const bulkDelete = vi.fn(async () => async () => {})
const markRead = vi.fn(async () => {})
const setKeyword = vi.fn(async () => {})
vi.mock('../../services/mailActions', () => ({
  bulkArchive: (...a: unknown[]) => bulkArchive(...(a as [])),
  bulkDelete: (...a: unknown[]) => bulkDelete(...(a as [])),
  markRead: (...a: unknown[]) => markRead(...(a as [])),
  setKeyword: (...a: unknown[]) => setKeyword(...(a as [])),
}))
const buildReply = vi.fn((..._a: unknown[]) => ({ to: [] }))
vi.mock('../../services/send', () => ({
  buildReply: (...a: unknown[]) => buildReply(...a),
}))

const inbox = { id: 'mb-inbox', role: 'inbox' } as unknown as Mailbox

const ctx = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc',
  ownEmail: 'alice@example.test',
  mailboxId: 'mb-inbox',
  emailId: 'm1',
  mailboxes: [inbox],
  canSend: true,
  ...over,
})

/**
 * Mount the hook, press a key the way the browser would, unmount again.
 *
 * The unmount is not tidiness: the hook listens on window, so a mount left
 * standing goes on handling the next test's keypresses with the context it
 * was given — a press meant for a server that cannot send was answered by an
 * earlier mount that could.
 */
function press(key: string, target?: HTMLElement, over: Record<string, unknown> = {}) {
  const { unmount } = renderHook(() => useMailShortcuts(ctx(over) as never))
  try {
    const event = new KeyboardEvent('keydown', { key, bubbles: true })
    if (target) Object.defineProperty(event, 'target', { value: target })
    window.dispatchEvent(event)
  } finally {
    unmount()
  }
}

/**
 * Press a key and wait until the handler has acted.
 *
 * It reads the database first — one Dexie round trip, sometimes two — so
 * there is no fixed number of turns to wait: `until` names what the press was
 * supposed to produce and the wait ends there.
 */
async function pressAndSettle(
  key: string,
  until: () => unknown = () => true,
  over: Record<string, unknown> = {},
) {
  const { unmount } = renderHook(() => useMailShortcuts(ctx(over) as never))
  try {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await waitFor(() => expect(until()).toBeTruthy())
  } finally {
    unmount()
  }
}

describe('what the keyboard must keep its hands off', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUi.setState({ compose: null, helpOpen: false, messageDetailsOpen: false })
  })
  afterEach(() => useUi.setState({ compose: null, helpOpen: false, messageDetailsOpen: false }))

  it('does not act on a key typed into a field', () => {
    // `e` is archive here and a letter everywhere else. Hijacking it inside
    // an input would archive mail while somebody is writing a search term.
    const input = document.createElement('input')
    press('e', input)
    expect(bulkArchive).not.toHaveBeenCalled()
  })

  it('leaves a textarea and a rich-text editor alone too', () => {
    const textarea = document.createElement('textarea')
    press('e', textarea)

    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    press('e', editable)

    expect(bulkArchive).not.toHaveBeenCalled()
  })

  it('stays quiet while something modal is open', () => {
    // A single key acting on the message *behind* an open dialog is never
    // what the keypress meant.
    useUi.setState({ helpOpen: true })
    press('e')
    expect(bulkArchive).not.toHaveBeenCalled()

    useUi.setState({ helpOpen: false, messageDetailsOpen: true })
    press('e')
    expect(bulkArchive).not.toHaveBeenCalled()
  })

  it('ignores a key held with a modifier', () => {
    // Ctrl+E and friends belong to the browser and the operating system.
    const { unmount } = renderHook(() => useMailShortcuts(ctx() as never))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }))
    unmount()
    expect(bulkArchive).not.toHaveBeenCalled()
  })
})

describe('the keys that act on a message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUi.setState({ compose: null, helpOpen: false, messageDetailsOpen: false })
  })

  it('archives and deletes the one message the URL names', () => {
    // Not the whole conversation: taking the wider thing on a single key
    // would be worse than having no shortcut.
    press('e')
    expect(bulkArchive).toHaveBeenCalledWith('acc', ['m1'])

    press('#')
    expect(bulkDelete).toHaveBeenCalledWith('acc', ['m1'])
  })

  it('does nothing without a message open', () => {
    press('e', undefined, { emailId: undefined })
    expect(bulkArchive).not.toHaveBeenCalled()
  })

  it('opens the composer on c, and not on a server that cannot send', () => {
    press('c')
    expect(useUi.getState().compose).not.toBeNull()

    useUi.setState({ compose: null })
    press('c', undefined, { canSend: false })
    // The buttons for this are gone there too; a key that opens an editor
    // whose Send is disabled only wastes what gets typed into it.
    expect(useUi.getState().compose).toBeNull()
  })

  it('keeps reply, reply-all and forward behind the same gate', () => {
    for (const key of ['r', 'a', 'f']) {
      useUi.setState({ compose: null })
      press(key, undefined, { canSend: false })
      expect(useUi.getState().compose).toBeNull()
    }
  })

  it('opens the help overlay on ?', () => {
    press('?')
    expect(useUi.getState().helpOpen).toBe(true)
    useUi.setState({ helpOpen: false })
  })
})

describe('the g-i chord', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUi.setState({ compose: null, helpOpen: false, messageDetailsOpen: false })
  })

  it('goes to the inbox when the two keys follow each other', () => {
    const { unmount } = renderHook(() => useMailShortcuts(ctx() as never))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }))
    unmount()

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { mailboxId: 'mb-inbox' } }),
    )
  })

  it('does not fire on an i pressed long after the g', () => {
    // Otherwise a `g` from earlier in the session lies in wait, and the next
    // `i` typed anywhere navigates out of whatever is on screen.
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useMailShortcuts(ctx() as never))
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }))
      vi.advanceTimersByTime(5_000)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }))
      expect(navigate).not.toHaveBeenCalled()
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })
})

describe('the keys that need to read the message first', () => {
  const ACC = 'acc'

  const put = async (keywords: Record<string, true>) => {
    await db.emails.put({
      accountId: ACC,
      id: 'm1',
      threadId: 't1',
      receivedAt: 0,
      mailboxIds: ['mb-inbox'],
      mailboxDates: [],
      unread: 0,
      flagged: keywords['$flagged'] ? 1 : 0,
      payload: sealPlain({ id: 'm1', subject: 'hi', keywords } as never),
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    useUi.setState({ compose: null, helpOpen: false, messageDetailsOpen: false })
    await db.emails.clear()
    await db.bodyCache.clear()
  })

  it('toggles the flag against what the message currently has', async () => {
    // A key that always set it would leave no way to take it off again.
    await put({})
    await pressAndSettle('s', () => setKeyword.mock.calls.length)
    expect(setKeyword).toHaveBeenCalledWith(ACC, 'm1', '$flagged', true)

    vi.clearAllMocks()
    await put({ $flagged: true })
    await pressAndSettle('s', () => setKeyword.mock.calls.length)
    expect(setKeyword).toHaveBeenCalledWith(ACC, 'm1', '$flagged', false)
  })

  it('does nothing for a message that is no longer there', async () => {
    // Deleted on another device while the URL still names it.
    await pressAndSettle('s')
    await new Promise((r) => setTimeout(r, 0))
    expect(setKeyword).not.toHaveBeenCalled()
  })

  it('leaves the message after marking it unread', async () => {
    /*
     * Staying on it would mark it read again the moment the pane settles, so
     * the key would appear to do nothing at all.
     */
    await put({})
    await pressAndSettle('u', () => markRead.mock.calls.length)

    expect(markRead).toHaveBeenCalledWith(ACC, 'm1', false)
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { mailboxId: 'mb-inbox' } }),
    )
  })

  it('offers an undo after archiving, and says so when nothing moved', async () => {
    /*
     * bulkArchive answers null when no Archive mailbox could be created.
     * Staying quiet there looks exactly like success while the message has not
     * moved.
     */
    await put({})
    await pressAndSettle('e', () => useUi.getState().snackbar)
    expect(useUi.getState().snackbar?.actionLabel).toBeTruthy()

    useUi.setState({ snackbar: null })
    bulkArchive.mockResolvedValueOnce(null as never)
    await pressAndSettle('e', () => useUi.getState().snackbar)
    const failed = useUi.getState().snackbar
    expect(failed?.actionLabel).toBeUndefined()
    expect(failed?.message).toBeTruthy()
  })

  it('quotes the body it already has, and opens anyway when it has none', async () => {
    /*
     * The quote comes from the cached body. Fetching one first would make the
     * editor open late — and offline it would not open at all, which is
     * exactly when a reply is most likely to be written.
     */
    await put({})
    await pressAndSettle('r', () => buildReply.mock.calls.length)

    expect(buildReply.mock.calls[0]![2]).toBeNull()
    expect(useUi.getState().compose).not.toBeNull()

    // The composer the first reply opened is modal, and the hook ignores every
    // key while one is up.
    vi.clearAllMocks()
    useUi.setState({ compose: null })
    await db.bodyCache.put({
      accountId: ACC,
      emailId: 'm1',
      lastAccess: 0,
      payload: sealPlain({ emailId: 'm1', text: 'the body' } as never),
    })
    await pressAndSettle('r', () => buildReply.mock.calls.length)

    expect(buildReply.mock.calls[0]![2]).toMatchObject({ text: 'the body' })
  })

  it('picks the mode from the key that was pressed', async () => {
    // r, a and f share a branch; one falling through to the wrong mode sends
    // a reply to everyone who was only ever cc'd.
    await put({})
    for (const [key, mode] of [
      ['r', 'reply'],
      ['a', 'replyAll'],
      ['f', 'forward'],
    ] as const) {
      vi.clearAllMocks()
      useUi.setState({ compose: null })
      await pressAndSettle(key, () => buildReply.mock.calls.length)
      expect(buildReply.mock.calls[0]![3]).toBe(mode)
    }
  })
})

describe('the search shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUi.setState({ compose: null, helpOpen: false, messageDetailsOpen: false })
  })

  it('focuses the search field and swallows the key', () => {
    // Without preventDefault the slash is typed into the field it just
    // focused, and every search starts with one.
    const input = document.createElement('input')
    input.id = 'mail-search'
    document.body.append(input)
    try {
      const { unmount } = renderHook(() => useMailShortcuts(ctx() as never))
      const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      unmount()

      expect(document.activeElement).toBe(input)
      expect(event.defaultPrevented).toBe(true)
    } finally {
      input.remove()
    }
  })
})
