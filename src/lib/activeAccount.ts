import { useSyncExternalStore } from 'react'
import type { Account } from '../domain/account'

/*
 * Which account the screens show. Every account syncs in the background
 * whichever this is; it only picks what is on screen. Remembered per device,
 * and falls back to the first account when unset or no longer there.
 */

const KEY = 'mel:activeAccount'
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setActiveAccount(accountId: string): void {
  try {
    localStorage.setItem(KEY, accountId)
  } catch {
    // Private mode: the choice lasts until the tab closes, via the listeners.
  }
  chosen = accountId
  for (const fn of listeners) fn()
}

let chosen = read()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  // Another tab switching accounts switches this one too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    chosen = e.newValue
    fn()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

/** The account on screen, from the list `useAccounts()` gave. */
export function activeAccount(
  accounts: Account[] | undefined,
  id: string | null,
): Account | undefined {
  return accounts?.find((a) => a.id === id) ?? accounts?.[0]
}

export function useActiveAccount(accounts: Account[] | undefined): Account | undefined {
  const id = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => chosen,
  )
  return activeAccount(accounts, id)
}
