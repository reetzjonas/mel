import { connectionFor } from '../sync/connections'
import { syncAccount } from '../sync/engine'

async function edit(
  accountId: string,
  action: Parameters<
    NonNullable<Awaited<ReturnType<typeof connectionFor>>['mail']>['editMailbox']
  >[0],
): Promise<string | null> {
  const conn = await connectionFor(accountId)
  if (!conn.mail) return 'no mail provider'
  const r = await conn.mail.editMailbox(action)
  await syncAccount(accountId)
  return r.failure ? (r.failure.description ?? r.failure.type) : null
}

export const createMailbox = (accountId: string, name: string, parentId: string | null) =>
  edit(accountId, { create: { name, parentId } })

export const renameMailbox = (accountId: string, id: string, name: string) =>
  edit(accountId, { update: { id, name } })

export const deleteMailbox = (accountId: string, id: string) => edit(accountId, { destroy: id })
