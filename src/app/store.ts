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
  /** Start out encrypted and signed: a reply to a message that was encrypted. */
  encrypt?: boolean
  /**
   * The existing draft this compose window continues. Autosave replaces that
   * message instead of creating a second one, and sending destroys it.
   */
  draftId?: string
  inReplyTo?: string[]
  references?: string[]
  attachments?: OutgoingAttachment[]
  /**
   * Pictures the starting content refers to by `cid:` — a reopened draft's
   * own, or the ones inside a quoted message. Already on the server, so they
   * travel by blob id; one the writer deletes from the text is left out.
   */
  inlineImages?: OutgoingAttachment[]
}

/**
 * A message handed from the reading pane to the filter rules form.
 *
 * Kept here rather than in the URL for the same reason the composer's init is:
 * it is a one-shot handover between two screens, not an address anyone should
 * be able to bookmark or reload into.
 */
export interface FilterSeed {
  /** The sender the new rule should match. */
  from: string
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
  filterSeed: FilterSeed | null
  /** Set on the way into settings; the form clears it once it has read it. */
  setFilterSeed: (seed: FilterSeed | null) => void
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
   * Mail's bulk selection itself lives in `useSelection` (`lib/selection.ts`),
   * local to `mail.$mailboxId.tsx` where the row list it indexes into is
   * known. This is only the one signal that has to cross a boundary that
   * hook can't reach on its own: `MailboxSidebar` renders in the *parent*
   * route (`mail.tsx`), a sibling of the route holding the selection, not a
   * descendant of it, so dropping a dragged selection onto a folder there
   * can't call into the hook directly. Bumping this (the same shape as
   * `unlockVersion` above) is what tells that selection to clear itself,
   * the way the local mailboxId/filter change already does internally.
   */
  mailSelectionClearSignal: number
  clearMailSelection: () => void
}

let snackbarTimer: ReturnType<typeof setTimeout> | null = null

export const useUi = create<UiState>((set) => ({
  compose: null,
  openCompose: (init = {}) => set({ compose: init }),
  closeCompose: () => set({ compose: null }),
  filterSeed: null,
  setFilterSeed: (filterSeed) => set({ filterSeed }),
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

  mailSelectionClearSignal: 0,
  clearMailSelection: () =>
    set((s) => ({ mailSelectionClearSignal: s.mailSelectionClearSignal + 1 })),
}))
