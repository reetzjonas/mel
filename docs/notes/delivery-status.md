# Delivery status of sent mail

Issue #70. `sendEmail` creates the message and its `EmailSubmission` in one
request, and until this change that was the last mel heard of it. A
recipient the server refused afterwards left the message in Sent looking
exactly like one that arrived. Now a sent message whose recipient was refused
shows a band in the reading pane, naming the address and quoting the server's
reply. The list row gets a warning mark.

## What Stalwart reports (checked against 0.16)

- `deliveryStatus` is keyed by recipient, each with `delivered`, `smtpReply`
  and `displayed`.
- An unknown **local** mailbox is refused while the submission is made. The
  submission is still created, `undoStatus` is `final`, and the message
  moves to Sent. Right away the recipient reads `delivered: "no"` with the
  reply `550 5.1.2 Mailbox does not exist.` This is the case the e2e test
  covers (`compose.spec.ts`, mail to `nobody@localhost`).
- Everything accepted reads `delivered: "unknown"` with the reply
  `250 2.1.5 Queued`, including a local delivery that has long since landed.
  So Stalwart never says `yes` here, and mel does not show a positive status:
  there is none to show reliably.
- A remote recipient stays `unknown`/`Queued` while the queue works on it.
  How a later remote refusal shows up in the submission was not observed (no
  outbound network in the dev container). A temporary 4xx reply, if a server
  reports one, is shown as "delivery delayed". A permanent refusal also
  arrives as a bounce (DSN) mail in the inbox, which is the usual way to learn
  about it.
- An address with an invalid domain (`.invalid`) is refused at submission
  with `noRecipients`, before anything is sent. No submission exists, so that
  is the outbox's business (a failed `sendEmail`), not this band's.

## Why a window and not `/changes`

The status fills in without moving `EmailSubmission`'s state: `/changes` right
after a refusal reports nothing. A delta sync would store each submission
once and never see its outcome. So every sync pass runs
`EmailSubmission/query` (`after` a week ago, newest 100) plus `/get` by
back-reference in one request, and replaces the window in
`db.submissions` (`syncSubmissions` in `sync/engine.ts`). Rows older than the
window are kept only if they carry a failure, so a refused message keeps its
band after a week, and everything else is let go.

It costs one small request per pass, and only on accounts with the submission
capability. A server that answers with a method error (no `/query`) answers
null, and the table is left alone.

A refusal that arrives later triggers no push of its own, since no state
moved. It shows up on the next pass, which the bounce landing in the inbox
usually triggers.

## Being told, not just shown

A band that only Sent shows is one nobody sees. So a refusal also announces
itself.

- **New refusals.** `syncSubmissions` compares with what it had stored and
  hands every submission newly carrying a refusal to `announceDeliveryFailures`
  (`sync/deliveryEvents.ts`, a plain listener set: the sync cannot show
  anything, and the page does not otherwise hear from it). The Web Lock means
  only the syncing tab announces.
- **Not on the first pass.** A new sign-in (no `EmailSubmission` marker in
  `syncState`, which `resyncAccount` clears too) sets the baseline silently
  and stores last week's refusals as already seen.
- **Snackbar or system notification** (`services/deliveryAlerts.ts`, wired in
  `AppShell`). A page in view gets the snackbar "Not delivered to …" with
  "Show this message", which opens it in Sent. A page out of sight gets a
  system notification, if permitted, with the subject and a link to the
  message; the service worker's `notificationclick` follows `data.url`.
  Otherwise nothing, since the folder mark is still there later.
- **Folder mark.** A warning sign on Sent in the sidebar
  (`useSentNeedsAttention`) while Sent holds a refused message not looked at
  since. `seen` is a column on the row, local to the device, set when the
  band renders (`markFailuresSeen`) and carried over when the sync rewrites
  the row. The mark also goes when the message is deleted or leaves Sent. The
  band and the list mark stay on the message itself.
- **Letting go.** A refusal older than the window is kept until it has been
  seen **and** was sent over 30 days ago.

A closed app says nothing. Web Push only wakes the device for
`EmailDelivery`, and a changed status is not one. The bounce a remote refusal
brings is new mail, though, so it pushes as usual, and the next start
announces the refusal.

## Where the pieces live

- `domain/submission.ts`: the shape, `deliveryProblems()` (refused vs.
  temporarily turned away, cancelled sends ignored) and `hasFailure()`.
- `providers/jmap/mail.ts` `recentSubmissions()`, `mappers/mail.ts`
  `toSubmission()`: a `delivered` value the RFC does not name reads as
  `unknown`.
- `db.submissions` (schema v10): index on `[accountId+emailId]`, with
  recipients and replies inside the envelope. It is encrypted with the rest
  and purged on sign-out.
- `features/mail/DeliveryNotice.tsx` in the reading pane under the header,
  and `useUndeliveredIds()` for the list mark.

## Not done

- DSN and MDN blobs (`dsnBlobIds`, `mdnBlobIds`) are not read. Stalwart left
  them empty in every test.
- No read receipts (`displayed`).
- No undo of a submission from here. mel's own undo-send happens before the
  submission exists.
