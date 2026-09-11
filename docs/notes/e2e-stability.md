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
