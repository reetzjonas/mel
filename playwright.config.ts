import { defineConfig, devices } from '@playwright/test'

/*
 * Point the suite at an already-running deployment — the built container, say —
 * instead of the dev server. CI uses this to prove the image it is about to
 * push actually serves a working app, not just that the bundle compiled.
 */
const baseURL = process.env['MEL_E2E_BASE_URL'] ?? 'http://localhost:5173'
const external = Boolean(process.env['MEL_E2E_BASE_URL'])

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // All specs share one Stalwart account; start every run from the seeded
  // baseline so leftovers can't accumulate into slow syncs and timeouts.
  globalSetup: './e2e/global-setup.ts',
  // Specs share one pair of accounts and deliberately mutate their mail,
  // calendars, files and settings. Running one at a time is slower, but makes
  // a test's server-side state its own instead of letting another spec change
  // it between an action and its assertion.
  workers: 1,
  /*
   * A failure has to leave evidence behind. This used to say `on-first-retry`
   * with `retries` at its default of 0, so the trace it asked for could never
   * be produced — and with no html reporter, the `playwright-report/` the CI
   * job uploads was never written either ("No files were found with the
   * provided path"). Every red run therefore had to be diagnosed by guessing.
   *
   * Deliberately still no retries: the flakes in this suite have had real
   * causes every time (docs/notes/e2e-stability.md), so a red run stays red.
   * `retain-on-failure` is what makes that red run answerable.
   */
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // See the settings-sync project below: these two specs push settings
      // sync changes repeatedly, which races other specs doing the same.
      testIgnore: ['**/settings-sync.spec.ts', '**/theme-editor.spec.ts'],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      // Both projects drive the same Stalwart account, so they must not run
      // at the same time: the desktop specs archive mail, delete folders and
      // toggle encryption, which yanks the ground out from under the mobile
      // specs reading the very same mailbox. Running mobile after desktop
      // costs a few seconds and removes the whole class of cross-project races.
      dependencies: ['desktop'],
      // State-mutating flows run on desktop only — both projects share one
      // Stalwart account and would race each other.
      testIgnore: [
        '**/capabilities.spec.ts',
        '**/initial-sync.spec.ts',
        '**/unsubscribe.spec.ts',
        '**/mail-actions.spec.ts',
        '**/contacts.spec.ts',
        '**/calendar.spec.ts',
        '**/files.spec.ts',
        '**/sieve.spec.ts',
        '**/encryption.spec.ts',
        '**/offline.spec.ts',
        '**/folders-drafts.spec.ts',
        '**/threads.spec.ts',
        '**/navigation.spec.ts',
        '**/compose.spec.ts',
        '**/notes.spec.ts',
        '**/settings-sync.spec.ts',
        '**/theme-editor.spec.ts',
      ],
    },
    {
      /*
       * `.mel/settings.json` is one file, read-merge-written client-side
       * with no compare-and-swap (JMAP FileNode's `writeFileContent` takes
       * no ETag or version to condition on) — so two concurrent writers can
       * race a classic lost update: A reads, B reads, B writes, A writes
       * back its own (now-stale) copy of a field B just changed, quietly
       * reverting it. Scoping a push to only the field it actually changed
       * (`SyncedField[]`, see services/settings.ts) keeps an *unrelated*
       * field from ever being part of that race, but cannot remove the
       * race for two writes racing on the *same* file — that would need
       * the server to support a conditional write, which this draft
       * extension does not.
       *
       * In real use this needs two actual devices changing settings within
       * a couple of seconds of each other — rare, and self-healing on the
       * next push or full resync, which is why it is an accepted trade-off
       * (see docs/notes/settings-sync.md) rather than something this build
       * tries to solve with a retry loop. The e2e suite manufactures it
       * constantly: many spec files share one `alice@localhost` account
       * under two concurrent workers, and settings-sync.spec.ts and
       * theme-editor.spec.ts are the two that push repeatedly enough to
       * reliably collide with anything else pushing at the same time —
       * found as theme-editor.spec.ts's assertions flickering under
       * full-suite load. Both run here, alone, after every other project.
       */
      name: 'settings-sync',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['desktop', 'mobile'],
      testMatch: ['**/settings-sync.spec.ts'],
    },
    {
      // Chained after settings-sync, not run alongside it in the same
      // project: two files in one project can still be scheduled onto
      // different workers at once, which would let this race that spec
      // exactly the way it would race anything in desktop or mobile.
      name: 'theme-editor',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['settings-sync'],
      testMatch: ['**/theme-editor.spec.ts'],
    },
  ],
  webServer: external
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
      },
})
