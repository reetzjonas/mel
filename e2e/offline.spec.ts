import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('alice@localhost').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
}

async function serverKeywords(page: Page, subject: string): Promise<string[]> {
  return page.evaluate(async (subj) => {
    const auth = 'Basic ' + btoa('alice@localhost:korrekt-pferd-batterie-alice')
    const session = await (
      await fetch('http://localhost:8080/jmap/session', { headers: { Authorization: auth } })
    ).json()
    const acc = session.primaryAccounts['urn:ietf:params:jmap:mail']
    const res = await (
      await fetch('http://localhost:8080/jmap/', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
          methodCalls: [
            ['Email/query', { accountId: acc, filter: { subject: subj } }, 'c0'],
            [
              'Email/get',
              {
                accountId: acc,
                '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' },
                properties: ['keywords'],
              },
              'c1',
            ],
          ],
        }),
      })
    ).json()
    const list = res.methodResponses[1][1].list as Array<{ keywords: Record<string, boolean> }>
    return Object.keys(list[0]?.keywords ?? {})
  }, subject)
}

test('offline: cached mail readable, queued flag syncs on reconnect', async ({ page, context }) => {
  test.setTimeout(60_000)
  const SUBJECT = 'Willkommen bei mel'
  await login(page)

  // Open the mail once online so its body lands in the cache; ensure it is
  // unflagged so the offline flag is an observable server change.
  await page.getByText(SUBJECT).click()
  const frame = page.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('dies ist die erste Testmail')).toBeVisible()
  if ((await serverKeywords(page, SUBJECT)).includes('$flagged')) {
    await page.getByTitle('Remove flag').click()
    await expect
      .poll(() => serverKeywords(page, SUBJECT), { timeout: 15_000 })
      .not.toContain('$flagged')
  }

  await context.setOffline(true)

  // Body must come from the local cache after navigating away and back.
  await page.getByText('HTML-Test').click()
  await page.getByText(SUBJECT).click()
  await expect(frame.getByText('dies ist die erste Testmail')).toBeVisible()

  // Flag it while offline — optimistic UI, action queued in the outbox.
  await page.getByTitle('Flag', { exact: true }).click()

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  await expect
    .poll(() => serverKeywords(page, SUBJECT), { timeout: 20_000 })
    .toContain('$flagged')
})
