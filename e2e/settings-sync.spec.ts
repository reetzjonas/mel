import { expect, test, type Browser, type Page } from '@playwright/test'

/*
 * Runs in its own `settings-sync` Playwright project, strictly after both
 * `desktop` and `mobile` finish (see playwright.config.ts) rather than
 * inside the ordinary parallel desktop pass. These tests change the shared
 * alice account's *account-wide* theme preference, which every other
 * session on the account picks up almost immediately — including specs
 * that never touch settings sync themselves but do read computed theme
 * tokens (found via e2e/theme-editor.spec.ts flickering under full-suite
 * concurrency). See docs/notes/settings-sync.md.
 */

async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })
}

async function setTheme(page: Page, value: 'system' | 'light' | 'dark') {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Appearance' }).click()
  await page.getByRole('combobox', { name: 'Theme' }).selectOption(value)
  await page.getByRole('button', { name: 'Close settings' }).click()
}

/**
 * Proves a theme change actually reached the server, not just this page —
 * the same cross-context check the second test below already uses to prove
 * the *forward* direction, reused here for cleanup. Without this, a test
 * that resets the theme and closes its context immediately races its own
 * debounced push (`PUSH_DELAY_MS`, `services/settings.ts`): the context
 * tears down, and any pending timer/fetch it owned goes with it, before the
 * reset ever reaches `.mel/settings.json`. The account is then left on
 * `dark` for every test that runs after — found as `theme-editor.spec.ts`
 * failing with a different symptom on every run, all traced back to it
 * unexpectedly inheriting a dark account theme it never touched.
 */
async function expectThemePropagated(browser: Browser, expected: 'light' | 'dark') {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await login(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', expected, { timeout: 20_000 })
  await ctx.close()
}

test('a changed theme reaches .mel/settings.json, hidden from Files by default', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000)
  await login(page)
  await setTheme(page, 'dark')

  await page.getByRole('link', { name: 'Files' }).first().click()

  // Off by default: mel's own internal files stay out of the way.
  await expect(page.getByRole('button', { name: '.mel', exact: true })).toHaveCount(0)

  // The push is async (outbox → server → resync) — give it room, the same
  // way files.spec.ts waits out a real upload.
  await page.getByRole('button', { name: 'Show hidden files' }).click()
  await expect(page.getByRole('button', { name: '.mel', exact: true })).toBeVisible({
    timeout: 15_000,
  })

  await page.getByRole('button', { name: '.mel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'settings.json', exact: true })).toBeVisible()

  // Toggling off hides it again, immediately (purely local, no round trip).
  await page.getByRole('link', { name: 'Files' }).first().click()
  await page.getByRole('button', { name: 'Hide hidden files' }).click()
  await expect(page.getByRole('button', { name: '.mel', exact: true })).toHaveCount(0)

  // Clean up, so the next run (and the next test here) starts from the
  // account's default appearance rather than whatever this one left behind
  // — confirmed with a fresh context rather than assumed, since closing this
  // page immediately after clicking would otherwise race the reset's own
  // debounced push (see expectThemePropagated's comment).
  await setTheme(page, 'system')
  await expectThemePropagated(browser, 'light')
})

test('a preference set in one browser follows the same account into another', async ({
  browser,
}) => {
  test.setTimeout(60_000)
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  await login(page1)
  await setTheme(page1, 'dark')
  await expect(page1.locator('html')).toHaveAttribute('data-theme', 'dark')

  // A second, independent browser context logged into the very same account
  // — not a second account, which is what every other cross-context e2e
  // test here uses Bob for. This is the scenario the issue is titled after.
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await login(page2)

  // No manual sync trigger: the first account sync after login already
  // reconciles settings, and theme applies in place — no reload needed,
  // unlike a language change (see services/settings.ts).
  await expect(page2.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 20_000 })

  // Reset confirmed on page2 before closing anything — the same reasoning
  // as the first test's cleanup, just checked on the context already open
  // here rather than a fresh one.
  await setTheme(page1, 'system')
  await expect(page2.locator('html')).toHaveAttribute('data-theme', 'light', { timeout: 20_000 })
  await ctx1.close()
  await ctx2.close()
})
