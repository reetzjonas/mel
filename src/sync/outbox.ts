import type { CalendarEvent, ParticipationStatus } from '../domain/calendar'
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
  | {
      kind: 'event.rsvp'
      eventId: string
      participantId: string
      status: ParticipationStatus
    }

/**
 * Actions that can be replayed without duplicating anything: they set a value
 * rather than adding one, so running them twice lands in the same place.
 * Creates and sends are missing on purpose — replaying those risks a second
 * message or a duplicate contact.
 */
const REPLAYABLE = new Set([
  'email.update',
  'email.destroy',
  'contact.update',
  'contact.destroy',
  'event.update',
  'event.destroy',
  'event.rsvp',
])

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

/**
 * Put actions left `inflight` by a dead run back in the queue.
 *
 * An action is marked inflight while it executes. Close or reload the tab at
 * that moment and nothing ever resets it: flush only picks up `pending`, so the
 * row is stranded — never retried, never failed, silent — while the optimistic
 * local change gets reverted by the next sync. That is a move that appears to
 * work and then undoes itself.
 *
 * Reaching here means we hold the outbox lock and none of our own executes are
 * running, so anything still inflight belongs to a run that is gone.
 */
async function recoverStranded(accountId: string): Promise<void> {
  const rows = await db.outbox.where('accountId').equals(accountId).toArray()
  for (const row of rows) {
    if (row.status !== 'inflight') continue
    if (REPLAYABLE.has(row.kind)) {
      await db.outbox.update(row.seq!, { status: 'pending', notBefore: 0 })
    } else {
      console.warn(
        `[mel] outbox action "${row.kind}" was interrupted mid-flight and cannot be` +
          ' replayed without risking a duplicate, so it is marked failed.',
      )
      await db.outbox.update(row.seq!, {
        status: 'failed',
        reason: 'interrupted',
        failedAt: Date.now(),
      })
    }
  }
}

/** Replay pending actions in order. Transient failures back off; permanent ones are marked failed. */
export async function flush(accountId: string): Promise<void> {
  if (flushing.has(accountId) || !navigator.onLine) return
  flushing.add(accountId)
  try {
    await navigator.locks.request(`mel-outbox-${accountId}`, async () => {
      await recoverStranded(accountId)
      for (;;) {
        const now = Date.now()
        // toArray (query path) instead of .filter().first() — cursor reads
        // would bypass the crypto middleware's decryption.
        const rows = await db.outbox.where('accountId').equals(accountId).toArray()
        const row = rows
          .filter((r) => r.status === 'pending' && r.notBefore <= now)
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0]
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
              // Recorded while it is still retrying too: an action that keeps
              // backing off is the other way to be stuck, and the queue view
              // has nothing else to explain it with.
              reason: reasonOf(e),
            })
            scheduleFlush(accountId, backoff)
            break // keep ordering: don't run later actions past a stuck one
          }
          // A permanently failed action never reaches the server, while the
          // optimistic local change already happened — so the next sync quietly
          // undoes what the user asked for. Say so loudly enough to diagnose:
          // the count surfaces in the sync bar, the reason here.
          console.warn(`[mel] outbox action "${row.kind}" failed permanently and was dropped:`, e)
          await db.outbox.update(row.seq!, {
            status: 'failed',
            reason: reasonOf(e),
            failedAt: Date.now(),
          })
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

/**
 * How a failure is recorded on the row: a token, never a sentence.
 *
 * The reason is stored in a plain column (the encrypted payload holds the
 * action), so it has to stay a classification — a server's `description` can
 * quote what was submitted. Everything thrown from `execute` carries a
 * `reason` for exactly that purpose; the readable error keeps going to the
 * console.
 */
function reasonOf(e: unknown): string {
  const tagged = (e as { reason?: string } | null)?.reason
  if (tagged) return tagged
  if (e instanceof JmapError) return e.status ? `${e.kind} ${e.status}` : e.kind
  return 'error'
}

/** An error carrying the failure's own type as its reason token. */
function failureError(failure: {
  type: string
  description?: string | null
  permanent: boolean
}): Error {
  const err = new Error(failure.description ?? failure.type)
  return Object.assign(err, { permanent: failure.permanent, reason: failure.type })
}

/** Our own refusals, which never reach the server at all. */
function localError(message: string, reason: string): Error {
  return Object.assign(new Error(message), { permanent: true, reason })
}

/**
 * Put a failed action back in the queue, as if it had just been enqueued.
 *
 * Kept deliberately blunt: attempts go back to zero and the backoff is
 * dropped, because a retry is a person saying "the thing that was in the way
 * is gone now" — a server that was refusing at attempt six does not deserve
 * six more seconds of waiting once the mailbox it was missing exists.
 */
export async function retryAction(seq: number): Promise<void> {
  const row = await db.outbox.get(seq)
  if (!row || row.status === 'inflight') return
  await db.outbox.update(seq, {
    status: 'pending',
    attempts: 0,
    notBefore: 0,
    reason: undefined,
    failedAt: undefined,
  })
  scheduleFlush(row.accountId, 0)
}

/**
 * Throw a queued action away.
 *
 * The local optimistic change stays until the next sync overwrites it from the
 * server — which is the point: discarding means "never mind, the server's
 * version wins", and the sync is what makes that true. Callers sync afterwards
 * so the list stops showing a change that is not going to happen.
 */
export async function discardAction(seq: number): Promise<void> {
  const row = await db.outbox.get(seq)
  if (!row || row.status === 'inflight') return
  await db.outbox.delete(seq)
  void syncAccount(row.accountId).catch(() => {})
}

/**
 * The provider an action needs, or a refusal naming what is missing.
 *
 * Each case asks for its own. There used to be a guard on `conn.mail` ahead of
 * the whole switch, which meant a server offering contacts but no mail failed
 * every contact write as "noProvider" while the contacts provider sat right
 * there — and the queue view could only say that something was missing, not
 * that it was the wrong something.
 */
function need<T>(provider: T | null, what: string): T {
  if (!provider) throw localError(`no ${what} provider`, 'noProvider')
  return provider
}

async function execute(accountId: string, action: OutboxAction): Promise<void> {
  const conn = await connectionFor(accountId)

  switch (action.kind) {
    case 'email.update': {
      const r = await need(conn.mail, 'mail').setEmails(action.updates, [])
      throwIfAllPermanent(r.failed)
      return
    }
    case 'email.destroy': {
      const r = await need(conn.mail, 'mail').setEmails({}, action.ids)
      throwIfAllPermanent(r.failed)
      return
    }
    case 'contact.create': {
      const r = await need(conn.contacts, 'contacts').createContact(action.contact)
      if (r.failure) throw failureError(r.failure)
      // The server row arrives via sync; drop the optimistic temp row.
      await db.contacts.delete([accountId, action.tempId])
      return
    }
    case 'contact.update': {
      const failure = await need(conn.contacts, 'contacts').updateContact(action.contact)
      if (failure) throw failureError(failure)
      return
    }
    case 'contact.destroy': {
      const failure = await need(conn.contacts, 'contacts').destroyContacts(action.ids)
      if (failure && failure.type !== 'notFound') throw failureError(failure)
      return
    }
    case 'event.create': {
      const r = await need(conn.calendars, 'calendar').createEvent(action.event)
      if (r.failure) throw failureError(r.failure)
      await db.events.delete([accountId, action.tempId])
      return
    }
    case 'event.update': {
      const failure = await need(conn.calendars, 'calendar').updateEvent(action.event)
      if (failure) throw failureError(failure)
      return
    }
    case 'event.rsvp': {
      const cal = need(conn.calendars, 'calendar')
      const failure = await cal.rsvp(action.eventId, action.participantId, action.status)
      if (failure) throw failureError(failure)
      return
    }
    case 'event.destroy': {
      const failure = await need(conn.calendars, 'calendar').destroyEvents(action.ids)
      if (failure && failure.type !== 'notFound') throw failureError(failure)
      return
    }
    case 'email.send': {
      const mail = need(conn.mail, 'mail')
      // Upload any attachments still stored locally.
      for (const a of action.mail.attachments) {
        if (a.blobId || !a.localKey) continue
        const cached = await db.blobCache.get([accountId, a.localKey])
        if (!cached) throw localError('attachment lost', 'attachmentLost')
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
  // The set-error types are tokens already, so they double as the reason.
  const types = [...new Set(entries.map((f) => f.type))].join(', ')
  throw Object.assign(new Error(types), {
    permanent: entries.every((f) => f.permanent),
    reason: types,
  })
}

export function useOutboxAutoFlush() {
  // Called once from the app shell: replay when we come back online.
  window.addEventListener('online', () => {
    void db.accounts
      .toCollection()
      .primaryKeys()
      .then((ids) => {
        for (const id of ids) void flush(String(id))
      })
  })
}
