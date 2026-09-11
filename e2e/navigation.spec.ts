import { expect, test, type Page } from '@playwright/test'

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
  // The "…" menu button appears on hover. It used to replace the unread badge
  // — which hid the count exactly while the pointer was on the row — and being
  // taller than the badge it shifted every row below it. Both now share the
  // row: the button reserves its space permanently (`invisible`, not `hidden`).
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })

  const rows = page.locator('nav a[href^="/mail/"]')
  await expect(rows.first()).toBeVisible()
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i)
    const before = (await row.boundingBox())?.height
    await row.hover()
    expect((await row.boundingBox())?.height).toBe(before)

    // And the count stays readable underneath the pointer. Which folders carry
    // one is not fixed — earlier specs read mail and nothing resets $seen — so
    // this asserts per row that has a badge rather than naming the Inbox.
    const badge = row.locator('span', { hasText: /^\d+$/ })
    if (await badge.count()) await expect(badge).toBeVisible()
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

/** Settings are a modal: the gear opens it, and the tabs switch inside it. */
async function openSettings(page: Page, tab: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: tab }).click()
}

async function closeSettings(page: Page) {
  await page.getByRole('button', { name: 'Close settings' }).click()
}

test('the sync bar leads to the server feature list', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 15_000 })

  // The bar opens settings straight on the tab that carries the list, and the
  // open tab is in the URL rather than in component state.
  await page.getByTestId('sync-status').click()
  await expect(page).toHaveURL(/settings=account/)

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

test('an action that never reached the server is reported, not dropped quietly', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })

  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  const rows = page.locator('[data-testid="virtuoso-item-list"] [role="button"]')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  // 400 is permanent, so the outbox gives up rather than retrying. The local
  // change already happened optimistically, which is why silence here is worse
  // than useless: the next sync just undoes what the user asked for.
  const block = async () =>
    page.route('http://localhost:8080/jmap/**', async (route) => {
      const body = route.request().postData() ?? ''
      if (body.includes('Email/set')) return route.fulfill({ status: 400, body: 'nope' })
      return route.continue()
    })
  await block()

  /** Flags or unflags the first message, whichever it currently offers. */
  const toggleFlag = async () => {
    await rows.first().hover()
    await rows
      .first()
      .getByRole('button', { name: /^(Flag|Remove flag)$/ })
      .click()
  }
  await toggleFlag()

  await expect(page.getByTestId('sync-status')).toContainText('could not be sent', {
    timeout: 30_000,
  })
  expect(warnings.some((w) => w.includes('failed permanently'))).toBe(true)

  /*
   * ...and can then be dealt with. A count in the sync bar plus a line in the
   * console is a report, not a way out: the change never reached the server,
   * the next sync undoes it locally, and there was nothing to click.
   *
   * One failed action at a time on purpose. Queueing two and handling them
   * separately races: the second sits pending, and any flush trigger turns it
   * into a second entry between the assertion and the click. The sync bar
   * (which only exists on /mail) is the signal that the flush has finished —
   * reloading the app mid-flush instead lets the entry show up whenever the
   * recovery gets round to it. Opening the queue as a modal keeps the page, so
   * there is no reload to race with in the first place.
   */
  const entries = page.getByRole('listitem').filter({ hasText: 'Flag messages' })
  await openSettings(page, 'Account')
  await expect(entries).toHaveCount(1, { timeout: 15_000 })
  // Named by what it does, not by the method it uses, and with the server's
  // own refusal kept as a token.
  await expect(entries.first()).toContainText('Not sent')
  await expect(entries.first()).toContainText('400')

  // Discarding: gone for good, and the server's version stands.
  page.once('dialog', (d) => void d.accept())
  await entries.first().getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('Nothing is waiting to be sent.')).toBeVisible({ timeout: 10_000 })

  // And once more, to retry instead — keeping a failed action around rather
  // than dropping it is only worth anything if the cause can go away.
  await closeSettings(page)
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })
  await toggleFlag()
  await expect(page.getByTestId('sync-status')).toContainText('could not be sent', {
    timeout: 30_000,
  })

  await openSettings(page, 'Account')
  await expect(entries).toHaveCount(1, { timeout: 15_000 })
  await page.unroute('http://localhost:8080/jmap/**')
  await entries.first().getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('Nothing is waiting to be sent.')).toBeVisible({ timeout: 20_000 })

  await closeSettings(page)
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('sync-status')).not.toContainText('could not be sent')
})

/*
 * Settings moved from a screen of its own into a modal. The old address has to
 * keep working (bookmarks, anything still linking there), and the tab has to
 * survive the hop through /mail's inbox redirect rather than being dropped
 * with the rest of the search params.
 */
test('the old settings address opens the dialog, and Back closes it', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 15_000 })

  await page.goto('/settings')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/settings=general/)

  // Switching tabs replaces the entry, so one press of Back closes the dialog
  // instead of walking back through every tab that was looked at.
  await page.getByRole('tab', { name: 'Notifications' }).click()
  await expect(page).toHaveURL(/settings=notifications/)
  await page.getByRole('tab', { name: 'Security' }).click()
  await expect(page).toHaveURL(/settings=security/)

  await page.goBack()
  await expect(dialog).toBeHidden()
})

/*
 * The tabs hold very different amounts of content (two selects on General, a
 * queue plus the whole capability list on Account). A panel sized to whatever
 * is inside it would jump on every tab click, which reads as hectic — so the
 * frame is fixed and only its contents scroll.
 */
test('the settings dialog keeps its size across tabs', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('sync-status')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()

  const sizes: { tab: string; width: number; height: number }[] = []
  for (const tab of ['General', 'Mail', 'Notifications', 'Security', 'Account']) {
    await page.getByRole('tab', { name: tab }).click()
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
    const box = await dialog.boundingBox()
    sizes.push({ tab, width: box!.width, height: box!.height })
  }

  const first = sizes[0]!
  for (const size of sizes.slice(1)) {
    expect(size, `${size.tab} differs from ${first.tab}`).toEqual({
      tab: size.tab,
      width: first.width,
      height: first.height,
    })
  }
})

test('icon controls are labelled by the app tooltip, not the browser one', async ({ page }) => {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })

  const control = page.getByRole('button', { name: 'New folder', exact: true })
  // A leftover `title` would put the OS bubble back alongside this one, which
  // is the whole thing being replaced.
  await expect(control).not.toHaveAttribute('title')

  // The short timeout is the point: the native tooltip takes about a second.
  await control.hover()
  const tip = page.getByTestId('tooltip')
  await expect(tip).toHaveText('New folder', { timeout: 1000 })

  // Moving away dismisses it rather than leaving it over the page.
  await page.mouse.move(0, 0)
  await expect(tip).toHaveCount(0)
})

test('controls show a pointer, disabled ones do not', async ({ page }) => {
  // Tailwind 4 dropped the preflight rule that used to give buttons a pointer,
  // so this is set once globally — and worth pinning, because losing it again
  // makes every control in the app feel inert without breaking anything.
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })

  for (const control of [
    page.getByRole('button', { name: /^Theme:/ }),
    page.getByRole('button', { name: 'Sign out' }),
    page.getByRole('button', { name: 'New message' }),
  ]) {
    await expect(control).toHaveCSS('cursor', 'pointer')
  }
})
