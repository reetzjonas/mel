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

test('create a contact, see details, use it in compose autocomplete', async ({ page }) => {
  const surname = `Testling${Date.now() % 100000}`
  const email = `erika.${surname.toLowerCase()}@example.org`

  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()

  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Erika')
  await page.getByLabel('Last name').fill(surname)
  await page.locator('input[type="email"]').first().fill(email)
  await page.getByRole('button', { name: 'Save' }).click()

  // Detail view shows the new contact.
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()
  await expect(page.getByRole('article').getByText(email)).toBeVisible()

  // Autocomplete in compose finds it.
  await page.getByRole('link', { name: 'Mail' }).first().click()
  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('erika')
  await expect(page.getByRole('button', { name: new RegExp(email) })).toBeVisible({
    timeout: 5000,
  })
  await page.getByRole('button', { name: new RegExp(email) }).click()
  await expect(page.getByPlaceholder('To', { exact: true })).toHaveValue(`${email}, `)

  // Clean up — otherwise every run leaves another contact behind, and
  // suggestRecipients caps at 8 results, so old ones eventually crowd out
  // the one this test just created and looks for.
  await page.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Erika ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toHaveCount(0)
})

test('contact "send email" opens compose prefilled', async ({ page }) => {
  const surname = `SendMailTest${Date.now() % 100000}`
  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Erika')
  await page.getByLabel('Last name').fill(surname)
  await page
    .locator('input[type="email"]')
    .first()
    .fill(`erika.${surname.toLowerCase()}@example.org`)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()

  await page.getByRole('button', { name: 'Send email' }).click()
  await expect(page.getByPlaceholder('To', { exact: true })).not.toHaveValue('')

  // Clean up.
  await page.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Erika ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
})
