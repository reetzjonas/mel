import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Inbox')).toBeVisible({ timeout: 15_000 })
}

test('create, rename and delete a folder', async ({ page }) => {
  const name = `Ordner-${Date.now() % 100000}`
  await login(page)

  await page.getByTitle('New folder').click()
  await page.locator('form input').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  const folder = page.getByRole('link', { name })
  await expect(folder).toBeVisible({ timeout: 10_000 })

  await folder.hover()
  await folder.getByTitle('Folder actions').click()
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.locator('form input').fill(`${name}-neu`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const renamed = page.getByRole('link', { name: `${name}-neu` })
  await expect(renamed).toBeVisible({ timeout: 10_000 })

  page.on('dialog', (d) => void d.accept())
  await renamed.hover()
  await renamed.getByTitle('Folder actions').click()
  await page.getByRole('button', { name: 'Delete folder' }).click()
  await expect(page.getByRole('link', { name: `${name}-neu` })).toHaveCount(0, {
    timeout: 10_000,
  })
})

test('compose autosaves a draft into the Drafts folder', async ({ page }) => {
  const subject = `Entwurf-${Date.now() % 100000}`
  await login(page)

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Angefangener Text…')

  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })
  // Close without sending; the draft stays on the server.
  await page.getByTitle('Discard').click()

  await page.getByRole('link', { name: 'Drafts' }).click()
  await expect(page.getByText(subject)).toBeVisible({ timeout: 10_000 })
})
