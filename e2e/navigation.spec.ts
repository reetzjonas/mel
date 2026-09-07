import { expect, test } from '@playwright/test'

/*
 * Desktop-only (see testIgnore in playwright.config.ts): this asserts on
 * behaviour during the *initial* sync, so it can't run beside the desktop
 * specs mutating the same shared account — the churn perturbs the very sync
 * being measured.
 */
test('switching apps during the first sync is not undone by the inbox redirect', async ({
  page,
}) => {
  // Regression: /mail auto-opens the inbox once mailboxes finish syncing.
  // Without a guard that we're still on /mail, that redirect fires after the
  // user has already navigated away and drags them back to Mail.
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  // Leave for Calendar as soon as the link exists — i.e. mid-sync.
  await page.getByRole('link', { name: 'Calendar' }).first().click({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/calendar$/)
  // And stay there once the sync lands.
  await page.waitForTimeout(3000)
  await expect(page).toHaveURL(/\/calendar$/)
})

test('signing out clears the account and its cached data from the device', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  // Sign out as soon as the button exists, rather than waiting for a settled
  // inbox. Against the local Stalwart the first sync usually beats the click,
  // so this does not reliably exercise the sign-out-mid-sync race that
  // services/accounts.ts sequences around — it checks the wipe is complete.
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Sign out' }).click({ timeout: 15_000 })

  // Back to the setup screen, and no account row left behind.
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible({ timeout: 10_000 })
  const rows = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('mel')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const dbh = open.result
          // Contacts and events used to survive logout — they are not on the
          // list of tables the account teardown walked.
          const tx = dbh.transaction(['accounts', 'contacts', 'events'], 'readonly')
          Promise.all(
            ['accounts', 'contacts', 'events'].map(
              (name) =>
                new Promise<number>((res, rej) => {
                  const req = tx.objectStore(name).count()
                  req.onsuccess = () => res(req.result)
                  req.onerror = () => rej(req.error)
                }),
            ),
          ).then((counts) => resolve(counts.reduce((a, b) => a + b, 0)), reject)
        }
      }),
  )
  expect(rows).toBe(0)
})

test('folder rows keep their height on hover', async ({ page }) => {
  // The unread badge is swapped for the "…" menu button on hover. The button
  // used to be taller than the badge, so every row below the pointer shifted.
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Inbox')).toBeVisible({ timeout: 15_000 })

  const rows = page.locator('nav a[href^="/mail/"]')
  await expect(rows.first()).toBeVisible()
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i)
    const before = (await row.boundingBox())?.height
    await row.hover()
    expect((await row.boundingBox())?.height).toBe(before)
  }
})

test('the sidebar reports how updates are arriving', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  // Stalwart offers an event source, so the scheduler should settle on push
  // rather than the polling fallback.
  const status = page.getByTestId('sync-status')
  await expect(status).toContainText('Live updates', { timeout: 15_000 })

  // Pinned: it must not scroll away with the folder list.
  await page.setViewportSize({ width: 1280, height: 340 })
  const before = (await status.boundingBox())?.y
  await page.locator('nav div.overflow-y-auto').evaluate((e) => e.scrollTo(0, 9999))
  expect((await status.boundingBox())?.y).toBe(before)
})
