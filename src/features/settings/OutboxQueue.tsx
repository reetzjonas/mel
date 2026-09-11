import { useLiveQuery } from 'dexie-react-hooks'
import { formatRelativePast } from '../../lib/dates'
import { t } from '../../lib/i18n'
import { db, type OutboxRow } from '../../storage/db'
import { openEnvelope } from '../../storage/envelope'
import { discardAction, retryAction, type OutboxAction } from '../../sync/outbox'
import { secondaryButtonClass } from '../../ui/styles'
import { describeAction } from './queue'

/** Failed first: it is the only state anyone opens this list to deal with. */
function order(a: OutboxRow, b: OutboxRow): number {
  if ((a.status === 'failed') !== (b.status === 'failed')) return a.status === 'failed' ? -1 : 1
  return (a.seq ?? 0) - (b.seq ?? 0)
}

/**
 * What the row is doing, and whether it is worth waiting for.
 *
 * `attempts > 0` on a pending row is the second way to be stuck: it is not
 * failed, it is backing off, and without saying so the queue looks idle while
 * nothing gets through.
 */
function statusLine(row: OutboxRow): { text: string; failed: boolean } {
  if (row.status === 'failed') {
    const when = row.failedAt ? ` · ${formatRelativePast(row.failedAt)}` : ''
    return { text: `${t('queue.status.failed')}${when}`, failed: true }
  }
  if (row.status === 'inflight') return { text: t('queue.status.sending'), failed: false }
  if (row.attempts > 0) {
    return { text: `${t('queue.status.retrying')} · ${row.attempts}`, failed: false }
  }
  return { text: t('queue.status.waiting'), failed: false }
}

function Entry({ row }: { row: OutboxRow }) {
  let title: string
  try {
    const summary = describeAction(openEnvelope(row.payload) as OutboxAction)
    title = summary.count > 1 ? `${t(summary.label)} · ${summary.count}` : t(summary.label)
  } catch {
    // Sealed (a locked encrypted account) or written by a newer build: the
    // entry still has to be manageable, just named by its method.
    title = row.kind
  }
  const status = statusLine(row)
  // Nothing may touch a row that is being sent right now — the flush owns it.
  const busy = row.status === 'inflight'

  return (
    <li className="flex items-center gap-3 border-b border-line py-2 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span
          className={`block truncate text-xs ${status.failed ? 'text-danger' : 'text-ink-subtle'}`}
        >
          {status.text}
          {/* The token, not a sentence: the readable error is in the console,
              and this column sits outside the encrypted payload. */}
          {row.reason && <span className="font-mono"> · {row.reason}</span>}
        </span>
      </span>
      <button
        type="button"
        disabled={busy}
        className={`${secondaryButtonClass} shrink-0 px-3 py-1 text-xs disabled:opacity-40`}
        onClick={() => void retryAction(row.seq!)}
      >
        {t('queue.retry')}
      </button>
      <button
        type="button"
        disabled={busy}
        className={`${secondaryButtonClass} shrink-0 px-3 py-1 text-xs text-danger disabled:opacity-40`}
        onClick={() => {
          // Discarding loses the change for good, and the next sync puts the
          // server's version back over the local one — worth one question.
          if (window.confirm(t('queue.discardConfirm'))) void discardAction(row.seq!)
        }}
      >
        {t('queue.discard')}
      </button>
    </li>
  )
}

/**
 * The outbox, as something you can act on.
 *
 * A failed action used to be a number in the sync bar and a line in the
 * browser console: the change never reached the server, the next sync undid it
 * locally, and there was nothing to click. Here it can be retried — once
 * whatever blocked it is gone — or thrown away.
 */
export function OutboxQueue({ accountId }: { accountId: string }) {
  // toArray, not a cursor: the outbox carries an encrypted payload, and cursor
  // reads bypass the crypto middleware (see storage/crypto/middleware.ts).
  const rows = useLiveQuery(
    () => db.outbox.where('accountId').equals(accountId).toArray(),
    [accountId],
    [] as OutboxRow[],
  )

  if (!rows.length) return <p className="text-sm text-ink-muted">{t('queue.empty')}</p>
  return (
    <div className="space-y-2">
      <ul>
        {[...rows].sort(order).map((row) => (
          <Entry key={row.seq} row={row} />
        ))}
      </ul>
      <p className="text-xs text-ink-subtle">{t('queue.hint')}</p>
    </div>
  )
}
