import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'

export function normalizeImageSender(email: string): string {
  return email.trim().toLowerCase()
}

export async function imageSenders(accountId: string): Promise<string[]> {
  const row = await db.imageSenders.get(accountId)
  // A locked account grants no permission to contact a remote sender.
  return row?.payload.plain ? openEnvelope(row.payload) : []
}

export async function setImageSender(
  accountId: string,
  email: string,
  allowed: boolean,
): Promise<void> {
  const sender = normalizeImageSender(email)
  if (!sender) return
  await db.transaction('rw', db.accounts, db.imageSenders, async () => {
    // Do not recreate account data if a pending click races with sign-out.
    if (!(await db.accounts.get(accountId))) throw new Error('Account not found')
    const row = await db.imageSenders.get(accountId)
    const senders = new Set(row ? openEnvelope(row.payload) : [])
    if (allowed) senders.add(sender)
    else senders.delete(sender)
    await db.imageSenders.put({ accountId, payload: sealPlain([...senders].sort()) })
  })
}
