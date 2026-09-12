# e2e stability (the earlier "flakes" had real causes)

The suite was long regarded as sporadically flaky (~40% red full runs) and that was
put down to CPU load. That was **wrong** — there were real causes, all fixed:

0. **Accumulated inbox.** `global-setup` cleaned drafts/sent/folders but left the
   **inbox** untouched. With the RSVP test, real iMIP mail arrives every run
   ("Accepted: …" for alice, "Invitation: …" for bob) — after a few runs those sat
   above the seeded mail and the virtualised list stopped rendering
   `Willkommen bei mel`/`HTML-Test` at all. Symptom: several mail specs cannot find
   "their" message. Bob had accumulated **70** stale mails this way. `global-setup`
   now trims the inbox back to the seeded subjects (`SEEDED_INBOX`).

0a. **Stalwart provisions no Archive mailbox.** Its defaults are Inbox, Drafts,
   Sent Items, Deleted Items and Junk Mail, so the *first* archive action has to
   create one — which only shows up on a freshly seeded server, i.e. in CI and
   never locally once a run has created it. Two consequences: the assertion on
   the "Archived" snackbar gets a longer timeout, and `ensureArchiveId()` uses
   the id `Mailbox/set` returns instead of syncing the whole account to look it
   up (measured at 143ms vs 166ms locally — a real simplification, but *not*
   what made CI fail; do not credit it with that).
   The actual cause was the third instance of the same pattern as 0b:
   `archiveEmail` returns null when no Archive mailbox could be created and
   every call site did `if (undo) showSnackbar(...)`, so a failure was
   **indistinguishable from success** — nothing happened at all. All three call
   sites now report it.

0b. **Buttons that silently do nothing.** "New event" began with
   `if (!defaultCalendarId) return` — before the calendars had synced, clicking did
   nothing and the test ran into its timeout. Under load (2 workers) it hit that
   window roughly every third run. The button is `disabled` now, which makes
   Playwright wait on its own. **Rule: a handler that returns early belongs behind a
   visible `disabled`** — otherwise it is a dead button for people and tests alike.

1. **Accumulated test data.** Every run left drafts/sent mail/contacts/events behind
   (the draft-autosave test *must* leave a draft; failing tests skip their cleanup).
   After ~50 mails the initial sync got slow enough that 15s waits expired. →
   `e2e/global-setup.ts` resets both accounts to the seeded state before every run.
   Per-test cleanup alone is not enough in principle.
2. **A real app bug** (see `mail.tsx`): the inbox auto-redirect did not check whether
   you were still on `/mail`. Clicking Calendar/Contacts during the first sync yanked
   you back. Regression: `e2e/navigation.spec.ts`.
3. **Stalwart rate limit**: 25 mails per hour per sender/recipient pair. The send test
   goes alice→bob every run; after ~25 runs it produced `452 4.4.5 Rate limit
   exceeded` — visible only as "the mail never arrives". Switched off for dev in
   `seed.sh` (`x:MtaInboundThrottle`, `enable:false`).

Also: `workers: 2`, and `mobile` sits behind `desktop` via `dependencies` — every spec
drives the same account, and parallel files were archiving each other's mail. Green
full runs ever since. **If something flickers again, check these classes first
(account state, shared state, server limits) rather than assuming system load.**

## The reply-threading flake was a real bug (2026-09-11, fixed)

`threads.spec.ts` → "a reply joins the same conversation row" failed roughly one
run in two, and **this one was not account state**: it reproduced identically on
the tree before the settings-modal work (measured 1/3 green there, 1/2 green with
it), so neither branch caused it.

What a red run showed was two conversation rows, each reading "2 messages": the
original grouped with its own copy in Sent, and the reply grouped with its copy
in Sent. The server never joined them, because the reply went out with no
`In-Reply-To` and no `References` — the test clicks a row and hits Reply at once,
and `buildReply` took both from the **body cache**, which had not arrived yet.

`messageId` lived on `EmailBody` only. It now travels on `EmailHeader` too
(`messageId`/`references` added to `EMAIL_HEADER_PROPS`, mapped in
`providers/jmap/mappers/mail.ts`), and `buildReply` reads the header first and
falls back to the body only for headers cached before the fields existed — so a
reply composed from the list by keyboard, or from a reading pane still showing
its skeleton, is threaded the same as any other. Four consecutive green runs
afterwards, against 1/3 and 1/2 before. Covered by unit tests in
`services/send.test.ts`, which is the cheaper place to pin it than a 30s e2e run.

The moral for the next flake: this one looked exactly like environment noise and
was not. Two runs on a stashed tree settled it in four minutes — measure before
attributing.

One *other* race in the same test was fixed alongside: it waited for
`[aria-label$="messages"]` across the whole list, which any conversation left
over from another spec satisfies immediately, leaving the real wait to a 5s
default timeout. The badge is now scoped to the row under test.

## The inbox redirect had one window left (2026-09-12)

CI went red on `navigation.spec.ts` → "switching apps during the first sync is not
undone by the inbox redirect", with the URL sitting on `/mail/a` after the click on
Calendar — i.e. the exact symptom of bug 2 above, which the `pathname` guard was
supposed to have closed.

It looked like a regression from the commit it landed on (the previous run was
green). It was not: **re-running the same job on the same commit came back green**,
and the full suite against the built image passes locally. So it is intermittent,
and the moral from the threading flake applies again — measure before attributing.

What the measuring did show is a real window, and it is not the one you would
guess. Clicking a link updates the URL *synchronously* (instrumented: the URL is
already `/calendar` while that route's chunk is still held in flight), so a pending
navigation is not the problem. The problem is that the guard read `pathname` from
`useRouterState`, i.e. **this render's snapshot**. The mailboxes arriving and the
navigation leaving are two independent updates with no ordering between them, so a
render carrying the new mailboxes can commit while still closing over the old
pathname — and the effect then redirects after the user has already left.

`mail.tsx` now reads `router.latestLocation.pathname` inside the effect instead, so
the decision is made on the live location at the moment it runs rather than on
whatever this render happened to capture. `pathname` stays in the deps so arriving
back on `/mail` still re-runs it.

Honest limit: the interleaving could not be forced from outside the app — holding
the `Mailbox/get` response and the calendar route chunk in every combination did
not reproduce it. So the fix is reasoned from the mechanism, not demonstrated by a
red-then-green test. The e2e test remains the guard; if it flickers again, it is
worth instrumenting *which* of the two updates committed first rather than
widening a timeout.
