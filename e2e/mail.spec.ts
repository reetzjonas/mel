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

test('the mail list groups rows under sticky date headings', async ({ page }) => {
  await login(page)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  // Which bucket the seeded mail falls into depends on how long ago the server
  // was seeded, so assert on the grouping rather than on a particular label.
  const headings = page.getByRole('heading', { name: /^(Today|Yesterday|This week|Older)$/ })
  await expect(headings.first()).toBeVisible()

  // The heading has to precede the rows it labels, which is the whole point of
  // it — a header rendering below its group would still be "visible".
  const firstHeadingBox = await headings.first().boundingBox()
  const firstRowBox = await page.getByTestId('thread-subject').first().boundingBox()
  expect(firstHeadingBox!.y).toBeLessThan(firstRowBox!.y)
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
  await page.locator('footer span', { hasText: 'daten.csv' }).getByTitle('Download').click()
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

test('remote images are blocked by the frame policy, and load once released', async ({ page }) => {
  // The two policies mailFrameDoc() emits — that it emits exactly these is
  // pinned by src/lib/htmlSanitize.test.ts; what this checks is the half a unit
  // test cannot: that the browser actually enforces them.
  const doc = (imgSrc: string) =>
    `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'">
</head><body><img src="http://tracker.invalid/p.gif?u=42" width="1" height="1"></body></html>`

  const hits: string[] = []
  await page.route('**tracker.invalid**', (r) => {
    hits.push(r.request().url())
    return r.fulfill({ status: 200, contentType: 'image/gif', body: '' })
  })
  await page.goto('/mail')

  const render = async (html: string) => {
    await page.evaluate((d) => {
      document.querySelectorAll('#img-policy-probe').forEach((n) => n.remove())
      const f = document.createElement('iframe')
      f.id = 'img-policy-probe'
      f.srcdoc = d
      document.body.appendChild(f)
    }, html)
    await page.waitForTimeout(1000)
  }

  await render(doc('data: cid:'))
  expect(hits).toHaveLength(0)

  await render(doc('http: https: data: cid:'))
  expect(hits.length).toBeGreaterThan(0)
})

test('the folder list is reachable on mobile, where the sidebar is off-screen', async ({
  page,
  isMobile,
}) => {
  // Desktop keeps the permanent sidebar, so the drawer and its trigger do not
  // exist there at all.
  test.skip(!isMobile, 'the drawer only exists on the narrow layout')
  await login(page)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  // The trigger names the current folder — on a phone it is the only thing
  // that does, since the sidebar that would show it is hidden.
  const trigger = page.getByRole('button', { name: /^Inbox — / })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const drawer = page.getByRole('dialog', { name: 'Folders' })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('link', { name: /^Drafts( \d+)?$/ }).click()

  // Picking a folder navigates and closes the drawer behind itself.
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/mail\/[^/]+$/)
  await expect(page.getByRole('button', { name: /^Drafts — / })).toBeVisible()

  // Escape closes it without navigating.
  await page.getByRole('button', { name: /^Drafts — / }).click()
  await expect(page.getByRole('dialog', { name: 'Folders' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Folders' })).toBeHidden()
})
