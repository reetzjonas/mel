import { expect, test, type Page } from '@playwright/test'

// Desktop-only (see testIgnore in playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({ timeout: 15_000 })
}

const notice = (page: Page) => page.getByText('This message comes from a mailing list.')

/*
 * The bar is offered on the strength of the message's own headers, and only
 * there — an "Unsubscribe" button on ordinary mail would be a lie, and one on
 * a newsletter that cannot be left costs a click to discover as much.
 */
test('a newsletter offers the way out, and ordinary mail does not', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page)

  await page
    .getByRole('button', { name: /Willkommen bei mel/ })
    .first()
    .click()
  await expect(page.getByText('Hallo Alice').first()).toBeVisible({ timeout: 15_000 })
  await expect(notice(page)).toHaveCount(0)

  await page
    .getByRole('button', { name: /Newsletter-Test/ })
    .first()
    .click()
  await expect(notice(page)).toBeVisible({ timeout: 15_000 })
  // The fixture carries the RFC 8058 promise, so it is the one-click path
  // rather than a link to open.
  await expect(page.getByRole('button', { name: 'Unsubscribe', exact: true })).toBeVisible()
})

/*
 * The POST goes to the sender's own server, which has no reason to allow this
 * origin — so it is sent `no-cors` and the answer is opaque. What the app may
 * therefore claim is that the request went out, and nothing beyond that.
 */
test('one click sends the request and says only what it can know', async ({ page }) => {
  test.setTimeout(60_000)
  const posted: string[] = []
  // example.com must never actually be reached from a test.
  await page.route('https://example.com/**', async (route) => {
    posted.push(`${route.request().method()} ${route.request().url()}`)
    await route.fulfill({ status: 200, body: '' })
  })

  await login(page)
  await page
    .getByRole('button', { name: /Newsletter-Test/ })
    .first()
    .click()
  await expect(notice(page)).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Unsubscribe', exact: true }).click()

  await expect(page.getByText(/Unsubscribe request sent/)).toBeVisible({ timeout: 10_000 })
  expect(posted).toEqual(['POST https://example.com/unsub?id=42'])
})
