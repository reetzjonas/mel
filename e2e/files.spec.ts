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

test('select several items, move them into a folder, then delete them together', async ({
  page,
}) => {
  const box = `box-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Files' }).first().click()

  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByRole('textbox').fill(box)
  await page.getByRole('button', { name: 'New folder' }).last().click()
  await expect(page.getByRole('button', { name: box, exact: true })).toBeVisible({
    timeout: 10_000,
  })

  // Two files at the top level, beside the folder.
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
    { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('2') },
  ])
  await expect(page.getByRole('button', { name: 'two.txt', exact: true })).toBeVisible({
    timeout: 15_000,
  })

  // Tick both, and the toolbar turns into the selection one.
  await page.getByRole('checkbox', { name: 'Select one.txt' }).click()
  await page.getByRole('checkbox', { name: 'Select two.txt' }).click()
  await expect(page.getByText('2 selected')).toBeVisible()

  await page.getByRole('button', { name: 'Move to…' }).click()
  // Scoped to the dialog: the row behind it carries the same name.
  await page.getByRole('dialog').getByRole('button', { name: box, exact: true }).click()

  // Gone from the top level, both inside the folder.
  await expect(page.getByRole('button', { name: 'one.txt', exact: true })).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.getByRole('button', { name: box, exact: true }).click()
  await expect(page.getByRole('button', { name: 'one.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'two.txt', exact: true })).toBeVisible()

  // Delete both in one go from the selection toolbar.
  await page.getByRole('checkbox', { name: 'Select one.txt' }).click()
  await page.getByRole('checkbox', { name: 'Select two.txt' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('This folder is empty')).toBeVisible({ timeout: 15_000 })

  // Clean up the folder itself.
  await page.getByRole('link', { name: 'Files' }).last().click()
  await page
    .getByRole('listitem')
    .filter({ hasText: box })
    .getByRole('button', { name: /^Delete / })
    .click()
  await expect(page.getByRole('button', { name: box, exact: true })).toHaveCount(0, {
    timeout: 15_000,
  })
})

test('drag a file onto a folder to move it, and onto the breadcrumb to bring it back', async ({
  page,
}) => {
  const box = `drag-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Files' }).first().click()

  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByRole('textbox').fill(box)
  await page.getByRole('button', { name: 'New folder' }).last().click()
  await expect(page.getByRole('button', { name: box, exact: true })).toBeVisible({
    timeout: 10_000,
  })

  await page.locator('input[type="file"]').setInputFiles({
    name: 'dragged.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('x'),
  })
  await expect(page.getByRole('button', { name: 'dragged.txt', exact: true })).toBeVisible({
    timeout: 15_000,
  })

  // Driving the mouse by hand raises no HTML5 drag events in Chromium, so the
  // drag has to go through dragTo (docs/notes/gotchas-testing.md).
  await page
    .getByRole('listitem')
    .filter({ hasText: 'dragged.txt' })
    .dragTo(page.getByRole('listitem').filter({ hasText: box }))
  await expect(page.getByRole('button', { name: 'dragged.txt', exact: true })).toHaveCount(0, {
    timeout: 15_000,
  })

  await page.getByRole('button', { name: box, exact: true }).click()
  await expect(page.getByRole('button', { name: 'dragged.txt', exact: true })).toBeVisible()

  // Back out to the top level by dropping on the root crumb — the listing has
  // no row for a folder above the one being viewed.
  await page
    .getByRole('listitem')
    .filter({ hasText: 'dragged.txt' })
    .dragTo(page.getByRole('link', { name: 'Files' }).last())
  await expect(page.getByText('This folder is empty')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Files' }).last().click()
  await expect(page.getByRole('button', { name: 'dragged.txt', exact: true })).toBeVisible({
    timeout: 10_000,
  })

  // Clean up both.
  await page
    .getByRole('listitem')
    .filter({ hasText: 'dragged.txt' })
    .getByRole('button', { name: /^Delete / })
    .click()
  await page
    .getByRole('listitem')
    .filter({ hasText: box })
    .getByRole('button', { name: /^Delete / })
    .click()
  await expect(page.getByRole('button', { name: box, exact: true })).toHaveCount(0, {
    timeout: 15_000,
  })
})

test('create a folder, upload into it, preview, rename and delete', async ({ page }) => {
  const folder = `probe-${Date.now() % 100000}`
  // Deleting a folder asks first, and an unhandled dialog blocks the click.
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Files' }).first().click()

  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByRole('textbox').fill(folder)
  await page.getByRole('button', { name: 'New folder' }).last().click()
  await expect(page.getByRole('button', { name: folder, exact: true })).toBeVisible({
    timeout: 10_000,
  })

  // Into the folder: the breadcrumb names it and the listing starts empty.
  await page.getByRole('button', { name: folder, exact: true }).click()
  await expect(page.getByText('This folder is empty')).toBeVisible()

  await page.locator('input[type="file"]').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from mel'),
  })
  await expect(page.getByRole('button', { name: 'note.txt', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  // The size comes from the server, so a row showing it proves the node was
  // stored with its content rather than created empty.
  await expect(page.getByRole('button', { name: 'note.txt', exact: true })).toContainText('14 B')

  // Preview reads the blob back off the server.
  await page.getByRole('button', { name: 'note.txt', exact: true }).click()
  await expect(page.getByText('hello from mel')).toBeVisible({ timeout: 10_000 })
  // Below lg the preview replaces the listing, so the row actions are only
  // reachable again once it is closed.
  await page.getByRole('button', { name: 'Back' }).click()

  await page
    .getByRole('button', { name: /^Rename / })
    .first()
    .click()
  await page.getByRole('textbox').fill('renamed.txt')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.getByRole('button', { name: 'renamed.txt', exact: true })).toBeVisible({
    timeout: 10_000,
  })

  // Back to the root and delete the folder whole — the service has to take the
  // file out from under it first, or the server refuses the parent.
  await page.getByRole('link', { name: 'Files' }).last().click()
  await expect(page.getByRole('button', { name: folder, exact: true })).toBeVisible()
  await page
    .getByRole('listitem')
    .filter({ hasText: folder })
    .getByRole('button', { name: /^Delete / })
    .click()
  await expect(page.getByRole('button', { name: folder, exact: true })).toHaveCount(0, {
    timeout: 15_000,
  })
})
