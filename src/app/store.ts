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
}))
