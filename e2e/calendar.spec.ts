import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('alice@localhost').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Inbox')).toBeVisible({ timeout: 15_000 })
}

function randomNextMonthDate(maxDay: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + 1, 1 + Math.floor(Math.random() * maxDay))
  return d.toISOString().slice(0, 10)
}

test('create a single and a weekly recurring event in the month view', async ({ page }) => {
  const title = `Standup-${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  // Random future days keep the target cells under the 3-chip display cap.
  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Date', { exact: true }).fill(randomNextMonthDate(20))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'next month' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Weekly recurring event shows up more than once in the grid.
  const weekly = `${title}-weekly`
  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(weekly)
  await page.getByLabel('Date', { exact: true }).fill(randomNextMonthDate(7))
  await page.getByRole('combobox', { name: 'Repeat' }).selectOption('weekly')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => page.getByRole('button', { name: new RegExp(weekly) }).count(), {
      timeout: 10_000,
    })
    .toBeGreaterThan(1)

  // Clean up so repeated runs don't fill the day cells past the chip cap.
  for (const name of [weekly, title]) {
    await page.getByRole('button', { name: new RegExp(name) }).first().click()
    await page.getByRole('button', { name: 'Delete event' }).click()
    await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0, {
      timeout: 10_000,
    })
  }
})

test('edit and delete an event', async ({ page }) => {
  const title = `Edit-${Date.now() % 100000}`
  // Random day next month — keeps the target day cell under the 3-chip cap.
  const next = new Date()
  next.setMonth(next.getMonth() + 1, 1 + Math.floor(Math.random() * 27))
  const dateValue = next.toISOString().slice(0, 10)

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Date', { exact: true }).fill(dateValue)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'next month' }).click()

  const chip = page.getByRole('button', { name: new RegExp(title) }).first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  await page.getByPlaceholder('Title').fill(`${title}-2`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: new RegExp(`${title}-2`) }).first()).toBeVisible()

  await page.getByRole('button', { name: new RegExp(`${title}-2`) }).first().click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(page.getByText('Event deleted')).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(`${title}-2`) })).toHaveCount(0)
})
