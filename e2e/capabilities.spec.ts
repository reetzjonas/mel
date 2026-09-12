import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })
}

/*
 * Both spellings of the session endpoint: `.well-known/jmap` is what login
 * asks for, and Stalwart redirects it to `/jmap/session`, which is the URL
 * that then gets stored and used by every reconnect afterwards.
 */
const SESSION = /\/(\.well-known\/jmap|jmap\/session)$/

/**
 * Answer the session request as a server that lacks these capabilities.
 *
 * Patching the *stored* account instead does not work, and that is the point:
 * every fresh connection now writes back what the session reports, so a
 * doctored row is corrected by the very reload that was meant to read it. The
 * only way to a server without the capability is to be that server.
 */
async function serverWithout(page: Page, urns: string[]) {
  await page.route(SESSION, async (route) => {
    const res = await route.fetch()
    const session = (await res.json()) as {
      accounts: Record<string, { accountCapabilities: Record<string, unknown> }>
    }
    for (const account of Object.values(session.accounts)) {
      for (const urn of urns) delete account.accountCapabilities[urn]
    }
    // Status spelled out rather than passed through: the first request of the
    // pair is a 307, and handing that status back with a body attached is not
    // a session response at all.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(session),
    })
  })
}

const composeButton = (page: Page) => page.getByRole('button', { name: 'New message' })

/*
 * Without the submission capability every send ends in the outbox as a
 * permanent failure, so the app used to let someone write a whole message
 * before saying so. Nothing offers to write one now — and the refresh in
 * settings is what takes that back once the server can send again, without
 * anyone having to sign out and in.
 */
test('a server that cannot send offers no way to write, until the refresh says otherwise', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await login(page)
  await expect(composeButton(page)).toBeVisible()

  await serverWithout(page, ['urn:ietf:params:jmap:submission'])
  await page.reload()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({ timeout: 15_000 })

  await expect(composeButton(page)).toHaveCount(0)
  // Mail is its own flag, so reading has to be exactly as it was.
  await expect(page.getByRole('link', { name: 'Mail', exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: /Willkommen bei mel/ })
    .first()
    .click()
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0)

  // The server takes mail for delivery again — and the point of persisting
  // what open() reports is that this needs no sign-out.
  await page.unroute(SESSION)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Account' }).click()
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(page.getByText('Up to date')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Close settings' }).click()

  await expect(composeButton(page)).toBeVisible({ timeout: 10_000 })
})

/*
 * The mail flag is its own gate: a calendar-only server used to put a
 * permanently empty mail view in front of you, tab and all.
 */
test('a server without mail hides the tab and says so on the screen', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page)

  await serverWithout(page, ['urn:ietf:params:jmap:mail'])
  await page.reload()

  await expect(page.getByText('This server does not offer mail.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: 'Mail', exact: true })).toHaveCount(0)
  // The other tabs are untouched, and the way to the full list is offered.
  await expect(page.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Server features' })).toBeVisible()
})
