import { expect, test, type Page } from '@playwright/test'

// Requires the seeded local Stalwart (npm run stalwart:seed).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
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

test('attachments open in a new tab (preview) and download', async ({ page, context }) => {
  await login(page)
  await expect(page.getByText('Mit Anhang')).toBeVisible({ timeout: 15_000 })
  await page.getByText('Mit Anhang').click()

  // Previewable PNG opens as a popup with a blob URL.
  const popup = context.waitForEvent('page', { timeout: 10_000 })
  await page.getByRole('button', { name: /pixel\.png/ }).click()
  const opened = await popup
  expect(opened.url()).toMatch(/^blob:/)
  await opened.close()

  // Explicit download button saves the file.
  const download = page.waitForEvent('download', { timeout: 10_000 })
  await page
    .locator('footer span', { hasText: 'daten.csv' })
    .getByTitle('Download')
    .click()
  expect((await download).suggestedFilename()).toBe('daten.csv')
})

test('HTML mail renders sanitized in the reading pane', async ({ page }) => {
  await login(page)

  await expect(page.getByText('HTML-Test')).toBeVisible({ timeout: 15_000 })
  await page.getByText('HTML-Test').click()
  const frame = page.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByRole('heading', { name: 'Hallo' })).toBeVisible()
  await expect(frame.getByRole('link', { name: 'Link' })).toBeVisible()
})
