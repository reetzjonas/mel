import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('alice@localhost').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
}

const PASSPHRASE = 'ein sehr sicherer testsatz'

async function countPlaintextLeaks(page: Page): Promise<number> {
  // Scan raw IndexedDB email rows for a known subject string.
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('mel')
        req.onsuccess = () => {
          const tx = req.result.transaction('emails', 'readonly')
          const all = tx.objectStore('emails').getAll()
          all.onsuccess = () => {
            const leaks = (all.result as unknown[]).filter((row) =>
              JSON.stringify(row).includes('Willkommen'),
            ).length
            req.result.close()
            resolve(leaks)
          }
        }
      }),
  )
}

test('enable encryption, reload, unlock, read mail — no plaintext at rest', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page)

  // Plaintext is present before enabling encryption.
  expect(await countPlaintextLeaks(page)).toBeGreaterThan(0)

  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByPlaceholder('Passphrase', { exact: true }).fill(PASSPHRASE)
  await page.getByPlaceholder('Repeat passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: 'Encrypt local data' }).click()
  await expect(page.getByText('Local data is encrypted')).toBeVisible({ timeout: 20_000 })

  // Raw store no longer contains the subject.
  expect(await countPlaintextLeaks(page)).toBe(0)

  // Reload → unlock gate → wrong passphrase rejected → correct one unlocks.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Unlock mel' })).toBeVisible({ timeout: 10_000 })
  await page.getByPlaceholder('Passphrase').fill('voellig falsch')
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(page.getByText('Wrong passphrase')).toBeVisible({ timeout: 15_000 })

  await page.getByPlaceholder('Passphrase').fill(PASSPHRASE)
  await page.getByRole('button', { name: 'Unlock' }).click()
  // Client-side navigation — a full reload would drop the in-memory DEK again.
  await page.getByRole('link', { name: 'Mail' }).first().click({ timeout: 15_000 })
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  // Clean up: disable encryption again for the other test runs.
  page.on('dialog', (d) => void d.accept(PASSPHRASE))
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Disable encryption' }).click()
  await expect(page.getByRole('button', { name: 'Encrypt local data' })).toBeVisible({
    timeout: 20_000,
  })
  expect(await countPlaintextLeaks(page)).toBeGreaterThan(0)
})
