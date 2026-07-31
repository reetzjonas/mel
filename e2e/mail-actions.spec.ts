import { expect, test, type Page } from '@playwright/test'

// Requires the seeded local Stalwart (npm run stalwart:seed).
async function login(page: Page, user: string, pass: string) {
  await page.goto('/mail')
  await page.getByPlaceholder('alice@localhost').fill(user)
  await page.getByRole('textbox', { name: 'Password' }).fill(pass)
  await page.getByRole('button', { name: 'Connect' }).click()
}

const ALICE = ['alice@localhost', 'korrekt-pferd-batterie-alice'] as const
const BOB = ['bob@localhost', 'korrekt-pferd-batterie-bob'] as const

test('archive a mail and undo it', async ({ page }) => {
  await login(page, ...ALICE)
  const firstRow = page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first()
  await expect(firstRow).toBeVisible({ timeout: 15_000 })
  // Whatever mail is on top — independent of previous runs' server state.
  // Reads a stable testid rather than indexing into the row's DOM structure.
  const subject = (await firstRow.getByTestId('thread-subject').innerText()).trim()

  await firstRow.click()
  await page.getByRole('article').getByTitle('Archive').click()

  await expect(page.getByText('Archived')).toBeVisible()
  await expect(page.getByText(subject).first()).toBeHidden()

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText(subject).first()).toBeVisible({ timeout: 10_000 })
  // Let the undo reach the server before the context is torn down.
  await page.waitForTimeout(1500)
})

test('compose, send, and receive on the other account', async ({ page, browser }) => {
  test.setTimeout(90_000)
  const subject = `e2e-${Date.now()}`

  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Hello Bob from the e2e test.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sending in 10 s')).toBeVisible()

  // Wait out the undo window plus delivery.
  await page.waitForTimeout(13_000)

  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await login(bobPage, ...BOB)
  await expect(bobPage.getByText(subject)).toBeVisible({ timeout: 30_000 })
  await bobPage.getByText(subject).click()
  const frame = bobPage.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('Hello Bob from the e2e test.')).toBeVisible()
  await bobCtx.close()
})

test('quick actions on list rows: flag and mark unread without opening', async ({ page }) => {
  await login(page, ...ALICE)
  const row = page
    .locator('[data-testid="virtuoso-item-list"] [role="button"]', { hasText: 'HTML-Test' })
    .first()
  await expect(row).toBeVisible({ timeout: 15_000 })

  await row.hover()
  await row.getByTitle('Flag', { exact: true }).click()
  await row.hover()
  await expect(row.getByTitle('Remove flag')).toBeVisible()
  await row.getByTitle('Remove flag').click()
  await row.hover()
  await expect(row.getByTitle('Flag', { exact: true })).toBeVisible()

  // Mark read/unread toggle from the list.
  await row.hover()
  const markUnread = row.getByTitle('Mark unread')
  const markRead = row.getByTitle('Mark read')
  if (await markUnread.isVisible()) {
    await markUnread.click()
    await row.hover()
    await expect(markRead).toBeVisible()
  } else {
    await markRead.click()
    await row.hover()
    await expect(markUnread).toBeVisible()
  }
})

test('search filters by subject server-side', async ({ page }) => {
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByPlaceholder(/Search/).fill('subject:Projektstand')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Kurzes Update')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Willkommen bei mel')).toBeHidden()
})
