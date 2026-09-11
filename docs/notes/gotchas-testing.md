# Hard-won gotchas: writing Playwright tests (do not rediscover)

- **`e2e/contacts.spec.ts` never used to clean up** → one more "Erika Testling…"
  contact every run, until `suggestRecipients` (capped at 8 hits) eventually pushed
  the newest one out and the test flickered. Fixed (it deletes itself now) — if
  contact autocomplete flakes reappear, check `ContactCard/get` on the account first
  for accumulated test corpses.
- Playwright's `getByRole({name: 'X'})` matches **case-insensitively as a substring**
  (not exact) — "Week" also matched leftovers with "…weekly" in the title. For short
  or generic labels (view switchers, action buttons) pass `exact: true`.

See also the accessible-name-plus-unread-counter trap and the "global-setup fails
on missing seed mail" note in `docs/notes/gotchas-jmap-mail.md`, and the shared-account
mobile/desktop rule plus calendar cell cap in `docs/notes/gotchas-calendar.md` — both
are e2e-authoring gotchas too, just filed with the feature they test.
