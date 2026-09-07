import { expect, test } from '@playwright/test'

test('app shell renders and redirects to /mail (login form without account)', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/mail$/)
  await expect(page.getByRole('heading', { name: 'Add account' })).toBeVisible()
})

test('app switcher navigates between apps (after login)', async ({ page }) => {
  await page.goto('/mail')
  // Without an account only Mail is offered (apps are capability-gated).
  await expect(page.getByRole('link', { name: 'Contacts' })).toHaveCount(0)

  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  await page.getByRole('link', { name: 'Contacts' }).first().click({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/contacts$/)
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await expect(page).toHaveURL(/\/calendar$/)
})
