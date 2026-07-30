import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      // State-mutating flows run on desktop only — both projects share one
      // Stalwart account and would race each other.
      testIgnore: [
        '**/mail-actions.spec.ts',
        '**/contacts.spec.ts',
        '**/calendar.spec.ts',
        '**/encryption.spec.ts',
        '**/offline.spec.ts',
      ],
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
})
