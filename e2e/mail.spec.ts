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

test('reading-pane actions spell themselves out when the pane is wide', async ({
  page,
  isMobile,
}) => {
  // Width here is the reading pane's, not the window's — the labels hang off a
  // container query, so a wide window with the list and sidebar next to it can
  // still be too narrow. A phone never has the room, so this is desktop-only.
  test.skip(isMobile, 'the pane is never wide enough on a phone')
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
  await page.getByText('Willkommen bei mel').click()

  const reply = page.getByRole('button', { name: 'Reply', exact: true })
  await expect(reply).toBeVisible()
  await expect(reply.getByText('Reply')).toBeVisible()

  // The row must not overflow once every label is out — that is what keeps the
  // reply group from being pushed off the edge.
  const bar = page.locator('article > div').first()
  const fits = await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(fits).toBe(true)

  // Narrower pane: icon-only again, while the accessible name stays put — the
  // button is still found by the very same role and name.
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(reply).toBeVisible()
  await expect(reply.getByText('Reply')).toBeHidden()
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
  await page
    .locator('footer span', { hasText: 'daten.csv' })
    .getByRole('button', { name: 'Download' })
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

test('message details: headers, delivery path, copy and export', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await login(page)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
  await page.getByText('Willkommen bei mel').click()
  await page.getByRole('button', { name: 'Message details' }).click()

  const dialog = page.getByRole('dialog')
  // The headers are fetched from the server when the dialog opens; everything
  // below them is read out of those headers.
  await expect(dialog.getByRole('heading', { name: 'Delivery path' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(dialog.getByText('seed.mel.dev').first()).toBeVisible()
  await expect(dialog.getByText('Delivered-To')).toBeVisible()
  await expect(dialog.getByText('Authentication', { exact: true })).toBeVisible()

  // A single-key shortcut must not reach the message behind the dialog — "e"
  // would otherwise archive it and navigate away under the open panel.
  await page.keyboard.press('e')
  await expect(dialog).toBeVisible()
  // The snackbar by role: "Archived" as loose text also matches the toolbar,
  // whose buttons read "Archive" and "Delete" back to back.
  await expect(page.getByRole('status')).toHaveCount(0)

  // Export before copy: the snackbar the copy raises sits over the footer on a
  // phone-sized viewport, and would swallow the click that follows it.
  const download = page.waitForEvent('download', { timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Save original' }).click()
  expect((await download).suggestedFilename()).toBe('Willkommen bei mel.eml')

  await dialog.getByRole('button', { name: 'Copy headers' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Message-ID:')

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
