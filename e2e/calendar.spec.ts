import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
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
  await page.getByRole('button', { name: 'next' }).click()
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

test('week view: click a time slot creates an event, editing opens the same event', async ({
  page,
}) => {
  const title = `Slot-${Date.now() % 100000}`
  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  // Click the 3 AM slot of today's column — well away from the 10:00 default
  // that "New event" and other tests use, so a leftover event there (from a
  // previous run that didn't clean up) can't visually cover this empty slot
  // (event chips are absolutely positioned and paint over the plain slot
  // divs beneath them). dayKey uses local date parts, same as the app —
  // not toISOString, which is UTC and can disagree.
  const now = new Date()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  await page.getByTestId(`slot-${todayKey}-3`).click()

  await expect(page.getByRole('heading', { name: 'New event' })).toBeVisible()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const chip = page.getByRole('button', { name: new RegExp(title) }).first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  await expect(page.getByPlaceholder('Title')).toHaveValue(title)

  // Clean up.
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(page.getByText('Event deleted')).toBeVisible()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0, {
    timeout: 10_000,
  })
})

test('day view shows the same event as week/month, and calendar visibility toggle hides it', async ({
  page,
}) => {
  const title = `DayView-${Date.now() % 100000}`
  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  // Switch to Day view first so the created event doesn't have to compete
  // with whatever else is on today's month-grid cell (3-chip display cap).
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Hide the (only/default) calendar via the sidebar checkbox -> event disappears.
  const firstCalendar = page.locator('aside label').first()
  await firstCalendar.click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0)
  await firstCalendar.click() // restore for other tests
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible()

  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0, {
    timeout: 10_000,
  })
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
  await page.getByRole('button', { name: 'next' }).click()

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

test('invite the other account, accept there, and see the reply on the organizer side', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000)
  const title = `Invite-${Date.now() % 100000}`
  // A random day next month keeps both accounts' month cells under the
  // 3-chip display cap when runs pile up.
  const day = randomNextMonthDate(20)

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Date', { exact: true }).fill(day)
  // Typing the full address avoids depending on contact autocomplete here.
  await page.getByLabel('Add attendee…').fill('bob@localhost')
  await page.getByLabel('Add attendee…').press('Enter')
  // The organizer is pinned in alongside the first attendee — without a
  // participant carrying the owner role Stalwart sends no invitation at all.
  // exact: the sidebar's "Stalwart Calendar (alice@localhost)" matches too.
  await expect(page.getByText('alice@localhost', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save and invite' }).click()

  await page.getByRole('button', { name: 'next' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Bob receives the invitation as a real event, not just an iMIP mail.
  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await bobPage.goto('/mail')
  await bobPage.getByPlaceholder('you@example.com').fill('bob@localhost')
  await bobPage.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-bob')
  await bobPage.getByRole('button', { name: 'Connect' }).click()
  await expect(bobPage.getByText('Inbox')).toBeVisible({ timeout: 15_000 })
  await bobPage.getByRole('link', { name: 'Calendar' }).first().click()
  await bobPage.getByRole('button', { name: 'next' }).click()

  const bobChip = bobPage.getByRole('button', { name: new RegExp(title) }).first()
  await expect(bobChip).toBeVisible({ timeout: 30_000 })
  await bobChip.click()
  // Bob is an attendee, so he gets the RSVP view rather than the editor.
  await expect(bobPage.getByRole('heading', { name: 'Invitation' })).toBeVisible()
  await bobPage.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(bobPage.getByText('Reply sent')).toBeVisible()

  // The iTIP reply travels by mail, so give it a moment to land.
  await page.getByRole('button', { name: new RegExp(title) }).first().click()
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Cancel' }).click()
        await page.getByRole('button', { name: new RegExp(title) }).first().click()
        return page.getByText('Accepted').count()
      },
      { timeout: 45_000, intervals: [3_000] },
    )
    .toBeGreaterThan(0)

  // Clean up on both sides (deleting sends bob a cancellation).
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toHaveCount(0, {
    timeout: 10_000,
  })
  await bobCtx.close()
})
