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
  drag has to go through `dragTo` — which resolves its target _before_ the drag
  begins. A drop target that only appears once the drag is under way therefore
  cannot be tested at all, which is a fair signal that it is also hard to aim
  at (see `drag-and-drop.md`).

## The e2e suite runs against the _built_ image (2026-09-12)

Not the dev server — `playwright.config.ts` takes `MEL_E2E_BASE_URL`, and CI
points it at the container. Treat that as a feature of the suite, because it is
the only thing here that sees what ships.

It earned its keep on the theme editor: CSS minification rewrites
`oklch(0.48 0.2 292)` as `oklch(48% .2 292)`, the colour parser rejected
percentages, and so the editor found no tokens at all in a production build
while every unit test stayed green. Unit tests could not have caught it — they
feed the parser the strings the _source_ contains.

Locally, without Docker:

```sh
npm run build && npx vite preview --port 4173 &
MEL_E2E_BASE_URL=http://localhost:4173 npx playwright test <spec>
```

**If a spec passes locally and fails in CI, run it this way before assuming
flake.** That is where the difference lives.

## `calendar.spec.ts`'s three drag tests: pre-existing, build-dependent, not load (2026-09-18)

While adding the "Upcoming" sidebar list (issue #93 phase 2), `drag an event to
another time and day, then resize it`, `drag a whole series onto another
weekday`, and `drag an event to another day in the month grid, then undo`
started failing intermittently — but only against the built preview, and only
sometimes even there (never against the dev server, where the same code ran
clean over a dozen consecutive full-suite runs). Bisecting by stashing just
`calendar.tsx`/`calendar.spec.ts` and rerunning against the _built_ preview
proved these three already fail on unmodified `main` — the new sidebar was
never the cause, it just happened to be under investigation when this surfaced.
The failure itself is `dragBy`'s simulated pointer gesture (real
`pointerdown`/`move`/`up`, not HTML5 dnd — see above) occasionally being read
as a click instead of a drag, which the two-attempts data available so far
can't pin to a specific frame being dropped.

What _did_ measurably help, so it is worth keeping regardless of whether it
was the root cause: `CalendarApp` re-renders on every `pointermove` during a
grid drag (`setDrag` in `TimeGrid.tsx`), and anything expensive elsewhere in
that render — re-running `Intl.DateTimeFormat.format()` for a sidebar list on
every one of those frames, say — competes with the drag for the same frame
budget. The sidebar's "Upcoming" rows are now resolved once into plain
objects (`upcomingRows`, gated on `useDeferredValue`) and the list itself is
`memo`'d, so a drag's repeated re-renders skip it entirely rather than
reconciling and reformatting up to `UPCOMING_LIMIT` rows on every frame.

Not fully closed at the time: these three still failed once in this session
against the built preview under concurrent Playwright workers, though never in
isolation. The cause turned out to be in the app, not in `dragBy` (issue #94).

**The real race (2026-09-18, fixed).** `onPointerMove` and `endDrag` read `drag`
from their render closure. React treats `pointermove` as a _continuous_ event
and does not flush its `setDrag` before the next _discrete_ one, so a
`pointerup` arriving while the last moves are still unrendered sees the drag
from before them — `past` still false — and the gesture is discarded as a
click. It needs the main thread to be busy, which is why it only showed under
concurrent workers and a production bundle, and why it is not reproducible on
demand: 18 of 18 runs were green on the unfixed code even with the browser
pinned to two cores and six busy loops beside it. It **is** reproducible in
jsdom, deterministically, by firing down/move/up inside one `act()`
(`TimeGrid.test.tsx`; red on the old code, green now). The handlers now read a
`dragRef` written in the same breath as the state.

If a drag test flickers again, the fix to distrust is not `dragBy`'s step
count — it is any new handler in `TimeGrid` that reads `drag` instead of
`dragRef.current`.
