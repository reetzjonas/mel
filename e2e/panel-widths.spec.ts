import { expect, test, type Page } from '@playwright/test'

/*
 * Runs on both projects, unlike most specs here: resizing a panel writes to
 * localStorage and touches nothing on the server, so it cannot race the
 * desktop flows over the shared account.
 *
 * The two halves are the point. On a wide screen there is a boundary to drag
 * and the width has to outlive a reload; on a phone the panes take turns and
 * there is no boundary at all, which is what keeps a width dragged on a
 * desktop from reaching a layout that has no room for it.
 */

async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
}

/** The message-list pane, named by the search box only it contains. */
const list = (page: Page) => page.locator('section:has(#mail-search)')

test('dragging the boundary resizes the message list, and the width survives a reload', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Two panes side by side exist only from lg up')

  await login(page)
  const rows = page.locator('[data-testid="virtuoso-item-list"] [role="button"]')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  const handle = page.getByRole('separator', { name: 'Message list width' })
  await expect(handle).toBeVisible()

  const before = (await list(page).boundingBox())!
  const grip = (await handle.boundingBox())!

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  // In steps: a single jump can be delivered as one move the handler sees
  // after the button is already up.
  await page.mouse.move(grip.x + 120, grip.y + grip.height / 2, { steps: 10 })
  await page.mouse.up()

  const after = (await list(page).boundingBox())!
  expect(after.width).toBeGreaterThan(before.width + 80)

  // Per device, which means it has to be there on the next visit.
  await page.reload()
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })
  const reloaded = (await list(page).boundingBox())!
  expect(Math.abs(reloaded.width - after.width)).toBeLessThan(4)

  // And back to where it started, so the next run finds the app as it was.
  await handle.dblclick()
  await expect(async () => {
    const reset = (await list(page).boundingBox())!
    expect(Math.abs(reset.width - before.width)).toBeLessThan(4)
  }).toPass()
})

test('the handles take no room from the panels they sit between', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Two panes side by side exist only from lg up')

  /*
   * Regression: the handles were a 4px strip each, and being flex children
   * they also earned the row's 12px gap on both sides — 16px per boundary,
   * 32px across both. The reading pane's action labels hang off a container
   * query at 768px, and at a 1440px window that pushed it under the threshold
   * so the buttons silently went back to icons. They now sit inside the
   * gutter with a negative margin cancelling their own gap.
   */
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  await expect(
    page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first(),
  ).toBeVisible({ timeout: 15_000 })

  const listBox = (await list(page).boundingBox())!
  const detail = (await page.locator('section:has(#mail-search) + * + *').boundingBox())!

  // Measured against the panel widths themselves: what the boundary costs is
  // whatever is left over between them, and one gutter is all it may be.
  const gutter = detail.x - (listBox.x + listBox.width)
  expect(gutter).toBeLessThanOrEqual(12)
})

test('the keyboard moves the boundary too', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Two panes side by side exist only from lg up')

  await login(page)
  await expect(
    page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first(),
  ).toBeVisible({
    timeout: 15_000,
  })

  const handle = page.getByRole('separator', { name: 'Message list width' })
  const before = (await list(page).boundingBox())!

  await handle.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')

  const after = (await list(page).boundingBox())!
  expect(after.width).toBeGreaterThan(before.width)
  // What a screen reader reads out has to follow the panel, not lag it.
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before.width - 1)

  await handle.dblclick()
})

test('a phone has no boundary to drag', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'This is about the narrow layout')

  await login(page)
  await expect(
    page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first(),
  ).toBeVisible({
    timeout: 15_000,
  })

  // Hidden below lg rather than merely unused: one pane fills the screen, so
  // a boundary would be a control with nothing on the other side of it.
  await expect(page.getByRole('separator', { name: 'Message list width' })).toBeHidden()
  await expect(page.getByRole('separator', { name: 'Folder list width' })).toBeHidden()
})
