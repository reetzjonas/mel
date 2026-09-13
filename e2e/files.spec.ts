import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })
}

test('create a folder, upload into it, preview, rename and delete', async ({ page }) => {
  const folder = `probe-${Date.now() % 100000}`
  // Deleting a folder asks first, and an unhandled dialog blocks the click.
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Files' }).first().click()

  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByRole('textbox').fill(folder)
  await page.getByRole('button', { name: 'New folder' }).last().click()
  await expect(page.getByRole('button', { name: folder })).toBeVisible({ timeout: 10_000 })

  // Into the folder: the breadcrumb names it and the listing starts empty.
  await page.getByRole('button', { name: folder }).click()
  await expect(page.getByText('This folder is empty')).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from mel'),
  })
  await expect(page.getByRole('button', { name: /note\.txt/ })).toBeVisible({ timeout: 15_000 })
  // The size comes from the server, so a row showing it proves the node was
  // stored with its content rather than created empty.
  await expect(page.getByRole('button', { name: /note\.txt/ })).toContainText('14 B')

  // Preview reads the blob back off the server.
  await page.getByRole('button', { name: /note\.txt/ }).click()
  await expect(page.getByText('hello from mel')).toBeVisible({ timeout: 10_000 })
  // Below lg the preview replaces the listing, so the row actions are only
  // reachable again once it is closed.
  await page.getByRole('button', { name: 'Back' }).click()

  await page.getByRole('button', { name: 'Rename' }).first().click()
  await page.getByRole('textbox').fill('renamed.txt')
  await page.getByRole('button', { name: 'Rename' }).last().click()
  await expect(page.getByRole('button', { name: /renamed\.txt/ })).toBeVisible({ timeout: 10_000 })

  // Back to the root and delete the folder whole — the service has to take the
  // file out from under it first, or the server refuses the parent.
  await page.getByRole('link', { name: 'Files' }).last().click()
  await expect(page.getByRole('button', { name: folder })).toBeVisible()
  await page
    .getByRole('listitem')
    .filter({ hasText: folder })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect(page.getByRole('button', { name: folder })).toHaveCount(0, { timeout: 15_000 })
})
