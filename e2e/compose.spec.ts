import { expect, test, type Page } from '@playwright/test'

// Requires the seeded local Stalwart (npm run stalwart:seed).
async function login(page: Page, user: string, pass: string) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill(user)
  await page.getByRole('textbox', { name: 'Password' }).fill(pass)
  await page.getByRole('button', { name: 'Connect' }).click()
}

const ALICE = ['alice@localhost', 'korrekt-pferd-batterie-alice'] as const
const BOB = ['bob@localhost', 'korrekt-pferd-batterie-bob'] as const

test('formatting toolbar output — bold, italic, a list and a link — survives to the recipient', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  const subject = `e2e-format-${Date.now()}`

  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)

  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.type('Intro. ')

  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('bold')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type(' ')
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.keyboard.type('italic')
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.keyboard.press('Enter')

  await page.getByRole('button', { name: 'Bulleted list' }).click()
  await expect(page.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.type('list item')

  // A link on freshly typed text: select it, then answer the URL prompt.
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Bulleted list' }).click() // leave the list
  page.once('dialog', (d) => void d.accept('https://example.com'))
  await page.keyboard.type('a link')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await page.getByRole('button', { name: 'Add link' }).click()
  await expect(page.getByRole('button', { name: 'Remove link' })).toBeVisible()

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sending in 10 s')).toBeVisible()
  await page.waitForTimeout(13_000)

  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await login(bobPage, ...BOB)
  await expect(bobPage.getByText(subject)).toBeVisible({ timeout: 30_000 })
  await bobPage.getByText(subject).click()
  const frame = bobPage.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('bold', { exact: true })).toBeVisible()
  await expect(frame.locator('strong', { hasText: 'bold' })).toBeVisible()
  await expect(frame.locator('em', { hasText: 'italic' })).toBeVisible()
  await expect(frame.locator('li', { hasText: 'list item' })).toBeVisible()
  const link = frame.getByRole('link', { name: 'a link' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://example.com')
  await bobCtx.close()
})

/*
 * Issue #49: the Reply buttons are live while the reading pane is still
 * fetching the body, and the composer used to quote whatever it had — which,
 * in that window, was nothing. Delaying the body fetch makes the window wide
 * enough to click in reliably; the quote has to turn up afterwards.
 */
test('a reply opened before the body arrives still gets its quote', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.route('http://localhost:8080/jmap/**', async (route) => {
    const body = route.request().postData() ?? ''
    // Only the body fetch: the header set the list is built from has no
    // bodyValues, so this leaves the rest of the app at full speed.
    if (body.includes('bodyValues')) await new Promise((r) => setTimeout(r, 4000))
    return route.continue()
  })

  await page.getByTestId('thread-subject').filter({ hasText: 'Willkommen bei mel' }).first().click()
  // Straight into the reply, without waiting for the pane to finish loading.
  await page.getByRole('button', { name: 'Reply', exact: true }).click()

  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  // Typing first, because the quote must land underneath what is being
  // written rather than on top of the cursor.
  await editor.click()
  await page.keyboard.type('meine antwort')

  await expect(editor.locator('blockquote')).toContainText('erste Testmail', { timeout: 20_000 })
  await expect(editor).toContainText('meine antwort')
})

test('Cc and Bcc reveal a recipient field each, independently', async ({ page }) => {
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New message' }).click()

  await expect(page.getByPlaceholder('Cc', { exact: true })).toBeHidden()
  await expect(page.getByPlaceholder('Bcc', { exact: true })).toBeHidden()

  await page.getByRole('button', { name: 'Cc', exact: true }).click()
  await expect(page.getByPlaceholder('Cc', { exact: true })).toBeVisible()
  // Revealing Cc must not also reveal Bcc, and vice versa below.
  await expect(page.getByPlaceholder('Bcc', { exact: true })).toBeHidden()

  await page.getByRole('button', { name: 'Bcc', exact: true }).click()
  await expect(page.getByPlaceholder('Bcc', { exact: true })).toBeVisible()

  await page.getByPlaceholder('Cc', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Bcc', { exact: true }).fill('bob@localhost')
})
