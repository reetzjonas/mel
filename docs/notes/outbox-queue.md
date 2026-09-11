# The outbox queue is visible and manageable

Settings → "Queued changes" (`features/settings/OutboxQueue.tsx`) lists what is
waiting, what is retrying and what was given up on, each with **Retry** and
**Discard**. Before this, a failed action was a number in the sync bar and a
line in the browser console: the change never reached the server, the next sync
undid it locally, and there was nothing to click.

- **The failure reason is persisted as a token, never a sentence**
  (`OutboxRow.reason`, e.g. `notFound`, `forbidden`, `protocol 400`). That
  column sits *outside* the encrypted payload, so it must stay a
  classification — a server's `description` can quote what was submitted.
  Everything thrown inside `execute()` therefore carries a `reason`
  (`failureError()`/`localError()`), and the readable error keeps going to the
  console. A **pending** row records it too: an action that keeps backing off
  is the other way to be stuck, and the list would otherwise look idle while
  nothing gets through.
- **What the entry says it does comes from the action, not the method name.**
  `describeAction()` (`features/settings/queue.ts`, pure and tested) reads the
  patch: `email.update` is used for moving, flagging *and* marking read, so
  "Move messages · 12" is the only version of that line anyone can act on. The
  description is built from the payload, which is the encrypted half of the
  row — it exists in the app, never in a column. A sealed payload (locked
  account) falls back to the raw `kind`, so the entry stays manageable.
- **Retry drops the backoff and the attempt count**: a person clicking retry is
  saying the obstacle is gone, and making them wait out the backoff of the
  attempt that failed answers a different question.
- **Discard asks first**, and the change is then gone: the next sync puts the
  server's version over the local optimistic one, which is the point.
- **Neither touches an `inflight` row.** The flush owns it — retrying would run
  it twice and deleting it would lose the outcome of a call already on its way.

Two things learned while testing this:

- The unit test for the inflight case needs **its own accountId**: `retryAction`
  schedules a flush, and a flush reaching that row recovers it as stranded
  (correctly — that is what `recoverStranded` is for) and completes it out from
  under the assertions.
- In e2e, **wait for the sync bar to report the failure before navigating to
  settings**. Going straight there reloads the app mid-flush, which strands the
  row and leaves it to the recovery path; the entry then appears whenever that
  gets round to it. The bar only exists on `/mail`, so the final "it is clean
  again" assertion has to go back there.
