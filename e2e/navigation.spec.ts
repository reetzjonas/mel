import { expect, test } from '@playwright/test'

/*
 * Desktop-only (see testIgnore in playwright.config.ts): this asserts on
 * behaviour during the *initial* sync, so it can't run beside the desktop
 * specs mutating the same shared account — the churn perturbs the very sync
 * being measured.
 */
test('switching apps during the first sync is not undone by the inbox redirect', async ({
  page,
}) => {
  // Regression: /mail auto-opens the inbox once mailboxes finish syncing.
  // Without a guard that we're still on /mail, that redirect fires after the
  // user has already navigated away and drags them back to Mail.
  await page.goto('/mail')
  await page.getByPlaceholder('alice@localhost').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  // Leave for Calendar as soon as the link exists — i.e. mid-sync.
  await page.getByRole('link', { name: 'Calendar' }).first().click({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/calendar$/)
  // And stay there once the sync lands.
  await page.waitForTimeout(3000)
  await expect(page).toHaveURL(/\/calendar$/)
})
