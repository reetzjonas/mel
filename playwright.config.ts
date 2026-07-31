import { defineConfig, devices } from '@playwright/test'

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
    baseURL: 'http://localhost:5173',
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
        '**/navigation.spec.ts',
      ],
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
})
