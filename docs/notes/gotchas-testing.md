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
- **HTML5 drag and drop: `locator.dragTo()` works, driving the mouse does not.**
  Chromium raises no drag events for synthetic `mouse.down`/`move`/`up`, so a
  drag has to go through `dragTo` — which resolves its target *before* the drag
  begins. A drop target that only appears once the drag is under way therefore
  cannot be tested at all, which is a fair signal that it is also hard to aim
  at (see `drag-and-drop.md`).

## The e2e suite runs against the *built* image (2026-09-12)

Not the dev server — `playwright.config.ts` takes `MEL_E2E_BASE_URL`, and CI
points it at the container. Treat that as a feature of the suite, because it is
the only thing here that sees what ships.

It earned its keep on the theme editor: CSS minification rewrites
`oklch(0.48 0.2 292)` as `oklch(48% .2 292)`, the colour parser rejected
percentages, and so the editor found no tokens at all in a production build
while every unit test stayed green. Unit tests could not have caught it — they
feed the parser the strings the *source* contains.

Locally, without Docker:

```sh
npm run build && npx vite preview --port 4173 &
MEL_E2E_BASE_URL=http://localhost:4173 npx playwright test <spec>
```

**If a spec passes locally and fails in CI, run it this way before assuming
flake.** That is where the difference lives.
