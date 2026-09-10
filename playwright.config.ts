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
  // Spec files run in parallel by default, but they all mutate one shared
  // mailbox — e.g. the archive test moves the top message out of the inbox
  // while another file is asserting on it. Two workers keeps some speed
  // without letting that many mutations overlap, and stops eight Chromium
  // instances from starving the dev server into timeout territory.
  workers: 2,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
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
        '**/mail-actions.spec.ts',
        '**/contacts.spec.ts',
        '**/calendar.spec.ts',
        '**/encryption.spec.ts',
        '**/offline.spec.ts',
        '**/folders-drafts.spec.ts',
        '**/threads.spec.ts',
        '**/navigation.spec.ts',
        '**/compose.spec.ts',
      ],
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
