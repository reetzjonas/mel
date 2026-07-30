import { useLiveQuery } from 'dexie-react-hooks'
import { useUi } from '../../app/store'
import type { Account } from '../../domain/account'
import type { EmailHeader } from '../../domain/email'
import type { Mailbox } from '../../domain/mailbox'
import { db } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'

export function useAccounts() {
  const unlockVersion = useUi((s) => s.unlockVersion)
  return useLiveQuery(async () => {
    const rows = await db.accounts.toArray()
    const out: Account[] = []
    for (const r of rows) {
      try {
        out.push(openEnvelope(r.payload).account)
      } catch {
        // Sealed (locked) account — the UnlockGate handles it.
      }
    }
    return out
  }, [unlockVersion])
}

const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
}

export function useMailboxes(accountId: string | undefined): Mailbox[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId) return []
    const rows = await db.mailboxes.where('accountId').equals(accountId).toArray()
    return rows
      .map((r) => openEnvelope(r.payload))
      .sort(
        (a, b) =>
          (ROLE_ORDER[a.role ?? ''] ?? 9) - (ROLE_ORDER[b.role ?? ''] ?? 9) ||
          a.sortOrder - b.sortOrder ||
          a.name.localeCompare(b.name),
      )
  }, [accountId])
}

export function useMailboxEmails(
  accountId: string | undefined,
  mailboxId: string | undefined,
): EmailHeader[] | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !mailboxId) return []
    const rows = await db.emails.where('mailboxIds').equals(mailboxId).toArray()
    return rows
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .map((r) => openEnvelope(r.payload))
  }, [accountId, mailboxId])
}

export function useEmail(
  accountId: string | undefined,
  emailId: string | undefined,
): EmailHeader | null | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !emailId) return null
    const row = await db.emails.get([accountId, emailId])
    return row ? openEnvelope(row.payload) : null
  }, [accountId, emailId])
}
