import { expect, test, type Page } from '@playwright/test'

// Requires the seeded local Stalwart (npm run stalwart:seed).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
}

/** The 10s undo window plus delivery; the send itself only starts after it. */
async function waitForSend(page: Page) {
  await expect(page.getByText('Sending in 10 s')).toBeVisible()
  await page.waitForTimeout(13_000)
}

/*
 * Alice writes to herself, which is the cheapest way to get a real threaded
 * exchange out of the server: the reply carries In-Reply-To/References and
 * Stalwart hands both messages back under one threadId. Nothing here fakes the
 * thread, because the grouping is only worth testing against ids the server
 * really assigned.
 */
test('a reply joins the same conversation row, and the pane lists both messages', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const subject = `e2e-thread-${Date.now()}`

  await login(page)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('alice@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('first message')
  await page.getByRole('button', { name: 'Send' }).click()
  await waitForSend(page)

  const listed = page.getByTestId('thread-subject').filter({ hasText: subject })
  await expect(listed.first()).toBeVisible({ timeout: 30_000 })

  // Reply to it, from the reading pane.
  await listed.first().click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('the answer')
  await page.getByRole('button', { name: 'Send' }).click()
  await waitForSend(page)

  // One row, not two: the reply joined the conversation instead of stacking a
  // second entry on top of it.
  const badge = page.locator('[aria-label$="messages"]')
  await expect(badge.first()).toBeVisible({ timeout: 30_000 })
  await expect(listed).toHaveCount(1)
  // The count spans folders, so the copies in Sent are in it too — what
  // matters is that it counts more than the one message in the inbox.
  expect(Number(await badge.first().innerText())).toBeGreaterThan(1)

  // Opening it shows one message expanded and the rest folded away. Pin that
  // the pane really is showing this conversation before looking for the folded
  // rows: the list reorders as the reply arrives, and a click that landed on a
  // neighbouring row would otherwise fail as "no folded messages".
  await listed.first().click()
  await expect(page.getByRole('heading', { name: new RegExp(subject) })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Show this message/ }).first()).toBeVisible({
    timeout: 15_000,
  })

  // Folding a message open swaps which body is rendered.
  const folded = page.getByRole('button', { name: /^Show this message/ }).first()
  await folded.click()
  await expect(page.locator('iframe[title="Message content"]')).toHaveCount(1)
})

test('turning conversations off puts every message back on its own row', async ({ page }) => {
  await login(page)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  const counted = await page.getByTestId('thread-subject').count()

  await page.goto('/settings')
  await page.getByLabel('Conversations').selectOption('off')
  await page.goto('/mail')
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  // Ungrouped can only ever show at least as many rows as grouped, and no
  // conversation counter survives the switch.
  expect(await page.getByTestId('thread-subject').count()).toBeGreaterThanOrEqual(counted)
  await expect(page.locator('[aria-label$="messages"]')).toHaveCount(0)

  await page.goto('/settings')
  await page.getByLabel('Conversations').selectOption('on')
})
