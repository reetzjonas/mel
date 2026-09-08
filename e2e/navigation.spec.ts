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
  const leftovers = await page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const open = indexedDB.open('mel')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const dbh = open.result
          // Contacts and events used to survive logout — they were not on the
          // list of tables the account teardown walked.
          const names = ['accounts', 'contacts', 'events', 'emails', 'mailboxes']
          const tx = dbh.transaction(names, 'readonly')
          Promise.all(
            names.map(
              (name) =>
                new Promise<[string, number]>((res, rej) => {
                  const req = tx.objectStore(name).count()
                  req.onsuccess = () => res([name, req.result])
                  req.onerror = () => rej(req.error)
                }),
            ),
          ).then((pairs) => resolve(Object.fromEntries(pairs)), reject)
        }
      }),
  )
  // Named per table: "1 row survived" on its own says nothing about where.
  expect(leftovers).toEqual({ accounts: 0, contacts: 0, events: 0, emails: 0, mailboxes: 0 })
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

test('a blocked connection is reported, not silently swallowed', async ({ page }) => {
  // An aborted request fails exactly like a CORS rejection does from JS: an
  // opaque "Failed to fetch" with no cause attached.
  await page.route('**/.well-known/jmap', (r) => r.abort('failed'))
  await page.route('**/jmap/session', (r) => r.abort('failed'))

  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  // Naming the hosts beats "no mail server found", which sends people looking
  // for a typo when the server is up but missing CORS headers.
  const error = page.locator('.text-danger').first()
  await expect(error).toContainText('CORS', { timeout: 20_000 })
  await expect(error).toContainText('localhost:8080')
})

test('a sync that cannot reach the server does not sit on "connecting"', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('sync-status')).toContainText('Live updates', { timeout: 15_000 })

  // Only the server origin: '**/jmap/**' would also match this app's own
  // modules under src/providers/jmap/ that Vite serves in dev, which blanks
  // the page and tests nothing.
  await page.route('http://localhost:8080/**', (r) => r.abort('failed'))
  await page.reload()

  await expect(page.getByTestId('sync-status')).toContainText('Server unreachable', {
    timeout: 20_000,
  })
})

test('the sync bar leads to the server feature list', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('sync-status').click()
  await expect(page).toHaveURL(/\/settings$/)

  const caps = page.locator('#server-capabilities')
  await expect(caps).toBeVisible()
  // Stalwart offers all of these, so they must read as supported.
  for (const feature of ['Mail', 'Contacts', 'Calendar', 'Sending mail']) {
    await expect(caps.getByRole('listitem').filter({ hasText: feature }).first()).toContainText(
      'supported',
    )
  }
  // Sieve is offered by the server but mel has no editor yet — say so.
  await expect(caps).toContainText('filter editor is not built yet')
})
