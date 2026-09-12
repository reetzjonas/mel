import { expect, test, type Page } from '@playwright/test'

// Desktop-only (see testIgnore in playwright.config.ts).

/**
 * Hold the first full-fetch request, so the app sits in the state a large
 * account spends minutes in: signed in, mailboxes known, not one message
 * fetched yet.
 *
 * The seeded account is far too small to produce that stretch on its own —
 * its whole mailbox arrives in one page — so the wait is made rather than
 * waited for.
 */
async function holdFirstFetch(page: Page): Promise<() => void> {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let first = true
  await page.route('**/jmap/**', async (route) => {
    if (first && (route.request().postData() ?? '').includes('Email/query')) {
      first = false
      await held
    }
    await route.continue()
  })
  return release
}

/*
 * A first login on a big mailbox showed "No messages" until the fetch
 * finished. That is not a slow answer, it is a wrong one: the folder is full,
 * we simply had not looked yet.
 */
test('the first sync says it is fetching, instead of calling the folder empty', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const release = await holdFirstFetch(page)

  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  await expect(page.getByText('Fetching your mail').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('No messages')).toHaveCount(0)

  release()

  // And once the mail is in, it gives way to the real list rather than
  // lingering.
  await expect(page.getByText('Willkommen bei mel').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Fetching your mail')).toHaveCount(0)
})
