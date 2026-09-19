import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  // Not the Inbox row: below `sm` the folder list lives in a drawer and the
  // inbox is a button there, so waiting for a link passes on a desktop and
  // times out on a phone with the app perfectly well logged in. The app
  // switcher is in both layouts, and only appears once the account is up.
  await expect(page.getByRole('link', { name: 'Contacts' }).first()).toBeVisible({
    timeout: 15_000,
  })
}

/*
 * Report the seeded account as nearly out of space.
 *
 * The alternative would be filling a real 1 GiB quota, which is not a test.
 * Only the one method response is rewritten, so everything else in the batch —
 * and every other call — still comes from the real server.
 */
async function storageNearlyFull(page: Page, fraction: number) {
  // The API endpoint carries a trailing slash (`/jmap/`), which `**/jmap`
  // does not match — the route then silently never fires.
  await page.route(/\/jmap\/?$/, async (route) => {
    if (!route.request().postData()?.includes('Quota/get')) return route.fallback()
    const res = await route.fetch()
    const body = (await res.json()) as {
      methodResponses: [string, { list?: Array<{ used: number; hardLimit: number }> }, string][]
    }
    for (const [name, args] of body.methodResponses ?? []) {
      if (name !== 'Quota/get') continue
      for (const quota of args.list ?? []) quota.used = Math.round(quota.hardLimit * fraction)
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

const warning = (page: Page) => page.getByRole('button', { name: /Storage almost full/ })

/** Resolves only once the deferred header quota read has reached the server. */
function waitForQuotaRead(page: Page) {
  return page.waitForResponse(
    (response) =>
      /\/jmap\/?$/.test(response.url()) &&
      response.request().postData()?.includes('Quota/get') === true &&
      response.ok(),
    { timeout: 15_000 },
  )
}

const AFTER_FIRST_READ = 12_000

/*
 * The seeded accounts carry a 1 GiB quota (docker/stalwart/seed.sh). Stalwart
 * reports no quota object at all for an account without a configured limit, so
 * without that the figure would correctly render nothing at all.
 */
test('settings names the storage figure', async ({ page }) => {
  await login(page)
  // A deep link into settings reads the quota during the app's startup burst,
  // where the request queues behind the initial sync; the section shows a
  // skeleton until it lands, so the figure is worth waiting for.
  await page.goto('/mail?settings=account&at=storage')

  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible()
  // Both halves: the bar alone would pass while reporting nothing readable.
  await expect(page.getByText(/of .* used/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Counts mail, files, calendars/)).toBeVisible()
})

test('a nearly empty account is not announced in the header', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), 'the warning lives in the shell header, which is desktop chrome')
  const quotaRead = waitForQuotaRead(page)
  await login(page)

  // The point of the whole design: the chrome every screen carries stays quiet
  // while the number is not worth acting on.
  await quotaRead
  await expect(warning(page)).toBeHidden()
})

test('nearly full storage is announced, and opens the detail', async ({ page, isMobile }) => {
  test.skip(Boolean(isMobile), 'the warning lives in the shell header, which is desktop chrome')
  await storageNearlyFull(page, 0.94)
  await login(page)

  await expect(warning(page)).toBeVisible({ timeout: AFTER_FIRST_READ })
  await expect(warning(page)).toContainText('94 %')

  await warning(page).click()
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible()
  await expect(page).toHaveURL(/settings=account/)
  await expect(page).toHaveURL(/at=storage/)
})
