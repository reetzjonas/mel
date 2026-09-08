import { create } from 'zustand'
import type { EmailAddress } from '../domain/email'
import type { OutgoingAttachment } from '../domain/identity'

export interface ComposeInit {
  to?: EmailAddress[]
  cc?: EmailAddress[]
  subject?: string
  /** Quoted original, appended below the cursor. */
  quotedHtml?: string
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
  toggleSelected: (mailboxId: string, id: string) => void
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
  unlockVersion: 0,
  bumpUnlock: () => set((s) => ({ unlockVersion: s.unlockVersion + 1 })),

  selection: [],
  selectionMailboxId: null,
  toggleSelected: (mailboxId, id) =>
    set((s) => {
      const base = s.selectionMailboxId === mailboxId ? s.selection : []
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
      return { selection: next, selectionMailboxId: next.length ? mailboxId : null }
    }),
  setSelection: (mailboxId, ids) =>
    set({ selection: ids, selectionMailboxId: ids.length ? mailboxId : null }),
  clearSelection: () => set({ selection: [], selectionMailboxId: null }),
}))
