import { expect, test, type Page } from '@playwright/test'

// Requires the seeded local Stalwart (npm run stalwart:seed).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('alice@localhost').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
}

test('login against Stalwart, browse inbox, read a mail', async ({ page }) => {
  await login(page)

  // Initial sync lands us in the inbox with the seeded mails.
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByText('Willkommen bei mel').click()
  await expect(page.getByRole('heading', { name: 'Willkommen bei mel' })).toBeVisible()
  const frame = page.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('dies ist die erste Testmail')).toBeVisible()
})

test('HTML mail renders sanitized in the reading pane', async ({ page }) => {
  await login(page)

  await expect(page.getByText('HTML-Test')).toBeVisible({ timeout: 15_000 })
  await page.getByText('HTML-Test').click()
  const frame = page.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByRole('heading', { name: 'Hallo' })).toBeVisible()
  await expect(frame.getByRole('link', { name: 'Link' })).toBeVisible()
})
