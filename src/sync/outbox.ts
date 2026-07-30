import type { CalendarEvent } from '../domain/calendar'
import type { Contact } from '../domain/contact'
import type { OutgoingEmail } from '../domain/identity'
import { JmapError } from '../providers/jmap/client/transport'
import { db } from '../storage/db'
import { openEnvelope, sealPlain } from '../storage/envelope'
import { connectionFor } from './connections'
import { syncAccount } from './engine'

export type OutboxAction =
  | { kind: 'email.update'; updates: Record<string, Record<string, unknown>> }
  | { kind: 'email.destroy'; ids: string[] }
  | { kind: 'email.send'; mail: OutgoingEmail; mailboxIds: { drafts: string; sent: string } }
  | { kind: 'contact.create'; contact: Contact; tempId: string }
  | { kind: 'contact.update'; contact: Contact }
  | { kind: 'contact.destroy'; ids: string[] }
  | { kind: 'event.create'; event: CalendarEvent; tempId: string }
  | { kind: 'event.update'; event: CalendarEvent }
  | { kind: 'event.destroy'; ids: string[] }

const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000

export async function enqueue(
  accountId: string,
  action: OutboxAction,
  opts?: { delayMs?: number },
): Promise<number> {
  const seq = await db.outbox.add({
    accountId,
    kind: action.kind,
    status: 'pending',
    attempts: 0,
    notBefore: Date.now() + (opts?.delayMs ?? 0),
    payload: sealPlain(action),
  })
  scheduleFlush(accountId, opts?.delayMs ?? 0)
  return seq
}

/** Cancel a queued action (undo-send during its delay window). */
export async function cancel(seq: number): Promise<boolean> {
  const row = await db.outbox.get(seq)
  if (!row || row.status === 'inflight') return false
  await db.outbox.delete(seq)
  return true
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleFlush(accountId: string, delayMs: number) {
  const existing = timers.get(accountId)
  if (existing) clearTimeout(existing)
  timers.set(
    accountId,
    setTimeout(() => {
      timers.delete(accountId)
      void flush(accountId)
    }, delayMs + 10),
  )
}

const flushing = new Set<string>()

/** Replay pending actions in order. Transient failures back off; permanent ones are marked failed. */
export async function flush(accountId: string): Promise<void> {
  if (flushing.has(accountId) || !navigator.onLine) return
  flushing.add(accountId)
  try {
    await navigator.locks.request(`mel-outbox-${accountId}`, async () => {
      for (;;) {
        const now = Date.now()
        const row = await db.outbox
          .where('accountId')
          .equals(accountId)
          .filter((r) => r.status === 'pending' && r.notBefore <= now)
          .first()
        if (!row) break
        await db.outbox.update(row.seq!, { status: 'inflight' })
        try {
          await execute(accountId, openEnvelope(row.payload) as OutboxAction)
          await db.outbox.delete(row.seq!)
        } catch (e) {
          const transient = e instanceof JmapError ? e.transient : !isPermanent(e)
          if (transient) {
            const attempts = row.attempts + 1
            const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
            await db.outbox.update(row.seq!, {
              status: 'pending',
              attempts,
              notBefore: Date.now() + backoff,
            })
            scheduleFlush(accountId, backoff)
            break // keep ordering: don't run later actions past a stuck one
          }
          await db.outbox.update(row.seq!, { status: 'failed' })
        }
      }
    })
  } finally {
    flushing.delete(accountId)
  }
  // Reconcile local optimistic state with the server's view.
  void syncAccount(accountId).catch(() => {})
}

function isPermanent(e: unknown): boolean {
  return Boolean((e as { permanent?: boolean } | null)?.permanent)
}

async function execute(accountId: string, action: OutboxAction): Promise<void> {
  const conn = await connectionFor(accountId)
  const mail = conn.mail
  if (!mail) throw Object.assign(new Error('no mail provider'), { permanent: true })

  switch (action.kind) {
    case 'email.update': {
      const r = await mail.setEmails(action.updates, [])
      throwIfAllPermanent(r.failed)
      return
    }
    case 'email.destroy': {
      const r = await mail.setEmails({}, action.ids)
      throwIfAllPermanent(r.failed)
      return
    }
    case 'contact.create': {
      const contacts = conn.contacts
      if (!contacts) throw Object.assign(new Error('no contacts provider'), { permanent: true })
      const r = await contacts.createContact(action.contact)
      if (r.failure) {
        const err = new Error(r.failure.description ?? r.failure.type)
        ;(err as Error & { permanent?: boolean }).permanent = r.failure.permanent
        throw err
      }
      // The server row arrives via sync; drop the optimistic temp row.
      await db.contacts.delete([accountId, action.tempId])
      return
    }
    case 'contact.update': {
      const contacts = conn.contacts
      if (!contacts) throw Object.assign(new Error('no contacts provider'), { permanent: true })
      const failure = await contacts.updateContact(action.contact)
      if (failure) {
        const err = new Error(failure.description ?? failure.type)
        ;(err as Error & { permanent?: boolean }).permanent = failure.permanent
        throw err
      }
      return
    }
    case 'contact.destroy': {
      const contacts = conn.contacts
      if (!contacts) throw Object.assign(new Error('no contacts provider'), { permanent: true })
      const failure = await contacts.destroyContacts(action.ids)
      if (failure && failure.type !== 'notFound') {
        const err = new Error(failure.description ?? failure.type)
        ;(err as Error & { permanent?: boolean }).permanent = failure.permanent
        throw err
      }
      return
    }
    case 'event.create': {
      const cal = conn.calendars
      if (!cal) throw Object.assign(new Error('no calendar provider'), { permanent: true })
      const r = await cal.createEvent(action.event)
      if (r.failure) {
        const err = new Error(r.failure.description ?? r.failure.type)
        ;(err as Error & { permanent?: boolean }).permanent = r.failure.permanent
        throw err
      }
      await db.events.delete([accountId, action.tempId])
      return
    }
    case 'event.update': {
      const cal = conn.calendars
      if (!cal) throw Object.assign(new Error('no calendar provider'), { permanent: true })
      const failure = await cal.updateEvent(action.event)
      if (failure) {
        const err = new Error(failure.description ?? failure.type)
        ;(err as Error & { permanent?: boolean }).permanent = failure.permanent
        throw err
      }
      return
    }
    case 'event.destroy': {
      const cal = conn.calendars
      if (!cal) throw Object.assign(new Error('no calendar provider'), { permanent: true })
      const failure = await cal.destroyEvents(action.ids)
      if (failure && failure.type !== 'notFound') {
        const err = new Error(failure.description ?? failure.type)
        ;(err as Error & { permanent?: boolean }).permanent = failure.permanent
        throw err
      }
      return
    }
    case 'email.send': {
      // Upload any attachments still stored locally.
      for (const a of action.mail.attachments) {
        if (a.blobId || !a.localKey) continue
        const cached = await db.blobCache.get([accountId, a.localKey])
        if (!cached) throw Object.assign(new Error('attachment lost'), { permanent: true })
        const { data, type } = openEnvelope(cached.payload)
        const up = await mail.uploadBlob(data, type)
        a.blobId = up.blobId
      }
      await mail.sendEmail(action.mail, action.mailboxIds)
      // Clean up local attachment blobs.
      for (const a of action.mail.attachments) {
        if (a.localKey) await db.blobCache.delete([accountId, a.localKey])
      }
      return
    }
  }
}

function throwIfAllPermanent(failed: Record<string, { type: string; permanent: boolean }>) {
  const entries = Object.values(failed)
  if (!entries.length) return
  const err = new Error(entries.map((f) => f.type).join(', '))
  ;(err as Error & { permanent?: boolean }).permanent = entries.every((f) => f.permanent)
  throw err
}

export function useOutboxAutoFlush() {
  // Called once from the app shell: replay when we come back online.
  window.addEventListener('online', () => {
    void db.accounts.toCollection().primaryKeys().then((ids) => {
      for (const id of ids) void flush(String(id))
    })
  })
}
