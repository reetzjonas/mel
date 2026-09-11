import { create } from 'zustand'
import type { EmailAddress, EmailHeader } from '../domain/email'
import type { OutgoingAttachment } from '../domain/identity'
import { conversationView, setConversationView } from '../lib/conversationView'

export interface ComposeInit {
  to?: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  subject?: string
  /** Quoted original, appended below the cursor. */
  quotedHtml?: string
  /**
   * Set instead of `quotedHtml` when the message being answered had no body
   * cached yet. The composer opens at once and fetches it, then appends the
   * quote — replying to a message that has just arrived used to quote nothing
   * at all, because the body was still on its way.
   */
  quoteSource?: {
    accountId: string
    header: EmailHeader
    mode: 'reply' | 'replyAll' | 'forward'
  }
  /**
   * The editor's whole starting content — a draft being picked up again,
   * rather than a quote written underneath a fresh message. Kept apart from
   * `quotedHtml` because the two differ in where the cursor goes and in
   * whether an empty paragraph is prepended.
   */
  bodyHtml?: string
  /**
   * The existing draft this compose window continues. Autosave replaces that
   * message instead of creating a second one, and sending destroys it.
   */
  draftId?: string
  inReplyTo?: string[]
  references?: string[]
  attachments?: OutgoingAttachment[]
}

interface Snackbar {
  message: string
  actionLabel?: string
  action?: () => void
}

interface UiState {
  compose: ComposeInit | null
  openCompose: (init?: ComposeInit) => void
  closeCompose: () => void
  snackbar: Snackbar | null
  showSnackbar: (s: Snackbar, timeoutMs?: number) => void
  hideSnackbar: () => void
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  /*
   * Mobile folder drawer. It lives here because the trigger sits in the
   * mailbox route while the drawer itself is rendered by the mail layout
   * above it — the two are siblings, not parent and child.
   */
  folderDrawerOpen: boolean
  setFolderDrawerOpen: (open: boolean) => void
  /*
   * The message metadata dialog. It lives here so the keyboard shortcuts can
   * see it: they are single keys, and `e` archiving the message *behind* an
   * open dialog is not something anyone means to do.
   */
  messageDetailsOpen: boolean
  setMessageDetailsOpen: (open: boolean) => void
  /*
   * Whether the mail list groups messages into conversations. Persisted in
   * localStorage, but mirrored here so flipping it in settings reaches the
   * mounted mail list — the two are in different routes.
   */
  conversationView: boolean
  setConversationView: (on: boolean) => void
  /** Bumped after unlocking encrypted accounts so live queries re-read. */
  unlockVersion: number
  bumpUnlock: () => void

  /*
   * Bulk selection. It lives here rather than in the list rows because the
   * thread list is virtualised — a row that scrolls out of view unmounts, and
   * with it any state it owned.
   */
  selection: string[]
  /** Which mailbox the selection belongs to; leaving it clears the selection. */
  selectionMailboxId: string | null
  /** One id, or every message of a conversation row at once. */
  toggleSelected: (mailboxId: string, ids: string | string[]) => void
  setSelection: (mailboxId: string, ids: string[]) => void
  clearSelection: () => void
}

let snackbarTimer: ReturnType<typeof setTimeout> | null = null

export const useUi = create<UiState>((set) => ({
  compose: null,
  openCompose: (init = {}) => set({ compose: init }),
  closeCompose: () => set({ compose: null }),
  snackbar: null,
  showSnackbar: (snackbar, timeoutMs = 10_000) => {
    if (snackbarTimer) clearTimeout(snackbarTimer)
    snackbarTimer = setTimeout(() => set({ snackbar: null }), timeoutMs)
    set({ snackbar })
  },
  hideSnackbar: () => {
    if (snackbarTimer) clearTimeout(snackbarTimer)
    set({ snackbar: null })
  },
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  folderDrawerOpen: false,
  setFolderDrawerOpen: (folderDrawerOpen) => set({ folderDrawerOpen }),
  messageDetailsOpen: false,
  setMessageDetailsOpen: (messageDetailsOpen) => set({ messageDetailsOpen }),
  conversationView: conversationView(),
  setConversationView: (on) => {
    setConversationView(on)
    set({ conversationView: on })
  },
  unlockVersion: 0,
  bumpUnlock: () => set((s) => ({ unlockVersion: s.unlockVersion + 1 })),

  selection: [],
  selectionMailboxId: null,
  toggleSelected: (mailboxId, ids) =>
    set((s) => {
      const list = typeof ids === 'string' ? [ids] : ids
      const base = s.selectionMailboxId === mailboxId ? s.selection : []
      // A conversation row is one thing to click, so it selects and deselects
      // as one: partially selected counts as not selected, and clicking it
      // takes the whole row in rather than toggling each message apart.
      const all = list.every((id) => base.includes(id))
      const next = all
        ? base.filter((id) => !list.includes(id))
        : [...base, ...list.filter((id) => !base.includes(id))]
      return { selection: next, selectionMailboxId: next.length ? mailboxId : null }
    }),
  setSelection: (mailboxId, ids) =>
    set({ selection: ids, selectionMailboxId: ids.length ? mailboxId : null }),
  clearSelection: () => set({ selection: [], selectionMailboxId: null }),
}))
