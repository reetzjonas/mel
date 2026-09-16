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

test('email, phone and address on a contact are each actionable', async ({ page }) => {
  const surname = `Clickable${Date.now() % 100000}`
  const email = `erika.${surname.toLowerCase()}@example.org`

  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Erika')
  await page.getByLabel('Last name').fill(surname)
  await page.locator('input[type="email"]').first().fill(email)
  // A new card starts without a phone line.
  await page.getByRole('button', { name: 'Add: Phone' }).click()
  await page.locator('input[type="tel"]').first().fill('(030) 12 34-56')
  await page.getByLabel('Address').fill('Hauptstr. 1, 10115 Berlin')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()

  // The separators that make a number readable are not part of the URI.
  await expect(page.getByRole('link', { name: `Call (030) 12 34-56` })).toHaveAttribute(
    'href',
    'tel:030123456',
  )
  await expect(
    page.getByRole('link', { name: /^Show on map Hauptstr\. 1, 10115 Berlin$/ }),
  ).toHaveAttribute('href', /openstreetmap\.org\/search\?query=Hauptstr/)

  // The address entry composes in mel rather than handing off to a mailto:
  // handler, so the reply stays in the app the contact lives in.
  await page.getByRole('button', { name: `Write to ${email}` }).click()
  await expect(page.getByPlaceholder('To', { exact: true })).toHaveValue(new RegExp(email))

  // Clean up.
  await page.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Erika ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
})

test('handles, tags, and removing a field the server already stored', async ({ page }) => {
  const surname = `Fields${Date.now() % 100000}`
  const email = `erika.${surname.toLowerCase()}@example.org`

  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Erika')
  await page.getByLabel('Last name').fill(surname)
  await page.locator('input[type="email"]').first().fill(email)
  await page.getByRole('button', { name: 'Add: Online' }).click()
  await page.getByLabel('Service').fill('Mastodon')
  await page.getByLabel('Handle').fill('@erika@chaos.social')
  await page.getByLabel('Tags').fill('friend, ski-club')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()
  await expect(page.getByText('@erika@chaos.social')).toBeVisible()
  await expect(page.getByText('ski-club')).toBeVisible()

  /*
   * The clearing case, which is why this runs against a real server: an update
   * is a JMAP patch, so a property mel leaves out is one the server keeps. This
   * used to "save" and leave the address exactly where it was.
   */
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.locator('input[type="email"]').first().fill('')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()
  await page.reload()
  await expect(page.getByText(email)).toHaveCount(0)

  // Clean up.
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Erika ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
})

// A 1x1 PNG, so the picker has a real image to decode without a fixture file.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('a contact photo is scaled, stored and shown', async ({ page }) => {
  const surname = `Photo${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Erika')
  await page.getByLabel('Last name').fill(surname)
  await page
    .getByLabel('Photo')
    .setInputFiles({ name: 'erika.png', mimeType: 'image/png', buffer: TINY_PNG })

  // The card holds the picture itself, so what is stored must be the scaled
  // JPEG mel made rather than the file that was picked.
  const preview = page.locator('form img')
  await expect(preview).toHaveAttribute('src', /^data:image\/jpeg;base64,/)

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()

  // Survives a reload, which is what proves it reached the server.
  await page.reload()
  await expect(page.getByRole('article').locator('img')).toHaveAttribute(
    'src',
    /^data:image\/jpeg;base64,/,
  )

  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: 'Remove' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.reload()
  await expect(page.getByRole('article').locator('img')).toHaveCount(0)

  // Clean up.
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Erika ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
})

test('a birthday reaches the card and shows up in the calendar', async ({ page }) => {
  const surname = `Bday${Date.now() % 100000}`
  // A date this month, so the calendar opens on it without navigating.
  const now = new Date()
  const day = new Date(now.getFullYear(), now.getMonth(), 15)
  const iso = `1985-${String(day.getMonth() + 1).padStart(2, '0')}-15`

  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Erika')
  await page.getByLabel('Last name').fill(surname)
  await page.getByLabel('Birthday').fill(iso)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()
  await expect(page.getByRole('article').getByText(/1985/)).toBeVisible()

  /*
   * The point of the field: it is derived into the calendar rather than stored
   * there, so it appears without anything having been written to a calendar.
   */
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  const entry = page.getByRole('button', { name: new RegExp(`Erika ${surname}`) })
  await expect(entry.first()).toBeVisible()

  // It has no event behind it, so it leads back to the card instead of an editor.
  await entry.first().click()
  await expect(page).toHaveURL(/\/contacts\//)
  await expect(page.getByRole('heading', { name: `Erika ${surname}` })).toBeVisible()

  // Clean up.
  await page.getByRole('button', { name: 'Delete contact' }).click()
})
