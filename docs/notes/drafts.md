# Drafts are reopened in the editor (not the reading pane)

A draft used to be a dead end: the reading pane can only *show* a message, so a
saved draft could be looked at and deleted and nothing else. It still opens in
the reading pane like every other message — **clicking the row deliberately
does not open the editor** (tried, and the user asked for it back: a modal
appearing on a plain list click is too much for a click that everywhere else
just shows you something). The pane's toolbar swaps reply/reply-all/forward for
**Edit draft** instead, and that button is the way in — those three make no
sense for your own unsent mail anyway.

`buildDraftInit()` (`services/send.ts`, pure and tested) turns the header plus
body back into a `ComposeInit`. Four things that are easy to miss:

- **`ComposeInit.draftId` is what makes it an edit** rather than a copy: the
  autosave passes it as `replaceId` (`Email/set` create + destroy in one call),
  so finishing a draft leaves one message, not a trail. Sending destroys it via
  the `discardDraft` that was already there.
- **Bcc only exists in the body.** It is not part of a delivered message, so it
  is deliberately not in the header property set — `EMAIL_BODY_PROPS` asks for
  `bcc` (and `inReplyTo`, for a draft that answers something) and `EmailBody`
  carries both as *optional* fields, since bodies cached before this have
  neither.
- **Plain text becomes paragraphs, not `<pre>`.** `bodyAsHtml()` (quoting) and
  `draftBodyHtml()` (editing) differ on purpose: Tiptap turns a `<pre>` into a
  code block, which is not what half-written prose should come back as.
- **Autosave is gated on a `dirty` flag**, not on "the fields are non-empty" as
  before. Opening a draft and closing it again must not rewrite it — every
  autosave replaces the message, so an idle reopen would churn through draft ids
  for nothing. Attachments come back by blob id (nothing is re-uploaded); inline
  `cid:` parts are left out, they belong to the HTML that references them.
- **There is a Save button next to Send**, and the footer says *which* state it
  is in ("Unsaved changes" / "Draft saved"). The autosave does work — verified
  against the real server — but it only fires 2.5 s after the last change and
  showed nothing until it did, so closing the window inside that gap dropped
  the edit silently and there was no way to make sure. Both paths go through
  one `storeDraft()`, and saves are **serialised through a promise queue**:
  each one replaces the draft (create + destroy in one `Email/set`), so two
  overlapping calls would each replace the other's message and leave a copy
  behind. `dirty` is cleared by a save only if `changeSeq` has not moved
  meanwhile, or a keystroke made during the request would be forgotten.
  `saveDraft()` returns `{id, ok}` rather than an id: replacing answers with
  the id it was handed, so failure and success are indistinguishable from
  outside — the autosave may ignore that, the button may not.
- **A saved draft has a new id, so the reading pane has to follow it**
  (`followDraft()`). An RFC 8621 Email is immutable apart from `mailboxIds`
  and `keywords`, so "saving" is create + destroy and the id necessarily
  changes; the pane behind the compose window stayed routed to the old one and
  emptied out mid-edit when the sync deleted it. It navigates (`replace`,
  since the previous entry names a message that no longer exists) — but only
  after `syncAccount()`, or the route renders "message not found" until the
  push-driven sync catches up. Sending is exempt: leaving the message there is
  fine, and the user said so.
  **Testing this needs the URL, not the pane.** Asserting that the pane is
  still there passes with or without the fix — it just beats the sync. The
  regression in `e2e/folders-drafts.spec.ts` polls `page.url()` instead, and
  was checked to fail when `followDraft` is removed.

The compose window also has a **Delete draft** button once a draft exists (the
close button only closes), and `AppShell` keys `<Compose>` on `draftId` so
opening a draft while another compose window stands open starts a new editor
instead of handing the old one an `init` it never reads again.

Covered by `src/services/send.test.ts` and three desktop e2e specs in
`e2e/folders-drafts.spec.ts` (reopen → finish → send; save on demand, which
also pins that no second copy appears; delete from the editor).
