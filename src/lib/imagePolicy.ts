/**
 * Whether remote images in mail may load without asking.
 *
 * Defaults to asking. A remote image is a network request to the sender the
 * moment a message is displayed, which is how read receipts and IP disclosure
 * work in email — and this client's whole premise is that it makes no
 * third-party request you did not ask for.
 */
import { useSyncExternalStore } from 'react'

export type ImagePolicy = 'ask' | 'always'

const KEY = 'mel:images'

export function imagePolicy(): ImagePolicy {
  return localStorage.getItem(KEY) === 'always' ? 'always' : 'ask'
}

export function setImagePolicy(policy: ImagePolicy): void {
  localStorage.setItem(KEY, policy)
  window.dispatchEvent(new Event('mel:image-policy'))
}

function subscribe(listener: () => void) {
  window.addEventListener('storage', listener)
  window.addEventListener('mel:image-policy', listener)
  return () => {
    window.removeEventListener('storage', listener)
    window.removeEventListener('mel:image-policy', listener)
  }
}

export function useImagePolicy(): ImagePolicy {
  return useSyncExternalStore(subscribe, imagePolicy)
}
