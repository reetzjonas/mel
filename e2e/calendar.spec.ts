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
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(title) })
      .first(),
  ).toBeVisible({
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
    .poll(
      async () =>
        page
          .locator('[data-testid="calendar-grid"]')
          .getByRole('button', { name: new RegExp(weekly) })
          .count(),
      {
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(1)

  // Clean up so repeated runs don't fill the day cells past the chip cap. The
  // weekly one is a series, so deleting it asks how far that reaches.
  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await page.getByRole('button', { name: 'All events' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(weekly) }),
  ).toHaveCount(0, {
    timeout: 10_000,
  })

  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(title) }),
  ).toHaveCount(0, {
    timeout: 10_000,
  })
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

  const chip = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  await expect(page.getByPlaceholder('Title')).toHaveValue(title)

  // Clean up.
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(page.getByText('Event deleted')).toBeVisible()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(title) }),
  ).toHaveCount(0, {
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
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(title) })
      .first(),
  ).toBeVisible({
    timeout: 10_000,
  })

  // Hide the (only/default) calendar via the sidebar checkbox -> event disappears.
  const firstCalendar = page.locator('aside label').first()
  await firstCalendar.click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(title) }),
  ).toHaveCount(0)
  await firstCalendar.click() // restore for other tests
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(title) })
      .first(),
  ).toBeVisible()

  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(title) }),
  ).toHaveCount(0, {
    timeout: 10_000,
  })
})

test('edit and delete an event', async ({ page }) => {
  const title = `Edit-${Date.now() % 100000}`
  // Random day next month — keeps the target day cell under the 3-chip cap.
  const dateValue = randomNextMonthDate(20)

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Date', { exact: true }).fill(dateValue)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'next' }).click()

  const chip = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await chip.click()
  await page.getByPlaceholder('Title').fill(`${title}-2`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(`${title}-2`) })
      .first(),
  ).toBeVisible({
    timeout: 10_000,
  })

  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(`${title}-2`) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(page.getByText('Event deleted')).toBeVisible()
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(`${title}-2`) }),
  ).toHaveCount(0)
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
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(title) })
      .first(),
  ).toBeVisible({
    timeout: 10_000,
  })

  // Bob receives the invitation as a real event, not just an iMIP mail.
  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await bobPage.goto('/mail')
  await bobPage.getByPlaceholder('you@example.com').fill('bob@localhost')
  await bobPage.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-bob')
  await bobPage.getByRole('button', { name: 'Connect' }).click()
  await expect(bobPage.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })
  // The iMIP mail itself carries the event as a text/calendar part, and the
  // reading pane offers it for a calendar — here it is already filed, because
  // the invitation was addressed to this account.
  const inviteMail = bobPage.getByText(new RegExp(`Invitation: ${title}`)).first()
  await expect(inviteMail).toBeVisible({ timeout: 30_000 })
  await inviteMail.click()
  await expect(bobPage.getByRole('heading', { name: 'Event in this message' })).toBeVisible({
    timeout: 15_000,
  })

  await bobPage.getByRole('link', { name: 'Calendar' }).first().click()
  await bobPage.getByRole('button', { name: 'next' }).click()

  const bobChip = bobPage
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(bobChip).toBeVisible({ timeout: 30_000 })
  await bobChip.click()
  // Bob is an attendee, so he gets the RSVP view rather than the editor.
  await expect(bobPage.getByRole('heading', { name: 'Invitation' })).toBeVisible()
  await bobPage.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(bobPage.getByText('Reply sent')).toBeVisible()

  // The iTIP reply travels by mail, so give it a moment to land.
  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click()
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Cancel' }).click()
        await page
          .locator('[data-testid="calendar-grid"]')
          .getByRole('button', { name: new RegExp(title) })
          .first()
          .click()
        return page.getByText('Accepted').count()
      },
      { timeout: 45_000, intervals: [3_000] },
    )
    .toBeGreaterThan(0)

  // Clean up on both sides (deleting sends bob a cancellation).
  await page.getByRole('button', { name: 'Delete event' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(title) }),
  ).toHaveCount(0, {
    timeout: 10_000,
  })
  await bobCtx.close()
})

test('birthdays are a calendar of their own, and can be switched off', async ({ page }) => {
  /*
   * They belong to no collection on the server, so they used to be the one
   * thing in the calendar nobody could turn off. The sidebar row is offered
   * only when there is a birthday to show.
   */
  const surname = `Vcal${Date.now() % 100000}`
  const now = new Date()
  const day = Math.min(28, Math.max(1, now.getDate() + 2))
  const iso = `1985-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  await login(page)
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Geburtstag')
  await page.getByLabel('Last name').fill(surname)
  await page.getByLabel('Birthday').fill(iso)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Geburtstag ${surname}` })).toBeVisible()

  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await expect(page.getByText(new RegExp(surname)).first()).toBeVisible({ timeout: 15_000 })

  const row = page.locator('aside label').filter({ hasText: 'Birthdays' })
  await row.click()
  await expect(page.getByText(new RegExp(surname))).toHaveCount(0)

  // Kept across a reload, the way the real calendars' visibility is.
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Birthdays' })).not.toBeChecked({
    timeout: 15_000,
  })

  await page.locator('aside label').filter({ hasText: 'Birthdays' }).click()
  await expect(page.getByText(new RegExp(surname)).first()).toBeVisible()

  // Clean up, or every run leaves another birthday in the calendar.
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Geburtstag ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
})

/** The day after an ISO date, as the date input spells it. */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Seven days on, as the date input spells it. */
function weekLater(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + 7)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** An hour later, as the time input spells it. */
function oneHourOn(hhmm: string): string {
  const [h, m] = hhmm.split(':')
  return `${String((Number(h) + 1) % 24).padStart(2, '0')}:${m}`
}

/** Drags from the middle of a block by the given pixels. */
async function dragBy(page: Page, block: ReturnType<Page['locator']>, dx: number, dy: number) {
  const box = (await block.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // Several steps: one jump would clear the threshold and the move in a single
  // event, which is not how a hand does it.
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + (dx * i) / 6,
      box.y + box.height / 2 + (dy * i) / 6,
    )
  }
  await page.mouse.up()
}

test('drag an event to another time and day, then resize it', async ({ page }) => {
  test.setTimeout(120_000)
  const title = `Drag-${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const block = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(block).toBeVisible({ timeout: 15_000 })
  await block.click()
  const startedOn = await page.getByLabel('Date', { exact: true }).inputValue()
  const startedAt = await page.getByLabel('Start', { exact: true }).inputValue()
  await page.getByRole('button', { name: 'Cancel' }).click()

  /*
   * Asserted on the dialog's own fields rather than the block's pixels. Two
   * workers share this account, and an event another spec happens to create in
   * the same hour splits the column into two — which moves the block sideways
   * for reasons that have nothing to do with the drag.
   */
  const width = (await block.boundingBox())!.width + 2
  await dragBy(page, block, width, 48)
  await page.waitForTimeout(1500)

  // Survives a reload: it went to the server, not just to the screen.
  await page.reload()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const reloaded = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(reloaded).toBeVisible({ timeout: 20_000 })
  await reloaded.click()
  expect(await page.getByLabel('Date', { exact: true }).inputValue()).toBe(nextDay(startedOn))
  expect(await page.getByLabel('Start', { exact: true }).inputValue()).toBe(oneHourOn(startedAt))
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Resize from the bottom edge: an hour longer, same start.
  const box = (await reloaded.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2 + (48 * i) / 6)
  }
  await page.mouse.up()
  await page.waitForTimeout(1500)
  const resized = (await reloaded.boundingBox())!
  // Loosely: the block under the pointer is drawn at hover scale, a percent
  // taller than what is stored.
  expect(Math.abs(resized.height - box.height - 48)).toBeLessThan(3)
  expect(Math.abs(resized.y - box.y)).toBeLessThan(3)

  await reloaded.click()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue(oneHourOn(startedAt))
  await page.getByRole('button', { name: 'Delete event' }).click()
})

test('a birthday stays put', async ({ page }) => {
  test.setTimeout(120_000)
  const surname = `Bday${Date.now() % 100000}`

  await login(page)

  // A contact with a birthday inside the week on screen.
  const now = new Date()
  const iso = `1985-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    Math.min(28, now.getDate()),
  ).padStart(2, '0')}`
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Geburtstag')
  await page.getByLabel('Last name').fill(surname)
  await page.getByLabel('Birthday').fill(iso)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Geburtstag ${surname}` })).toBeVisible()

  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  // Nothing on any server holds it, so there is nowhere for a move to go.
  const birthday = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(surname) })
    .first()
  await expect(birthday).toBeVisible({ timeout: 15_000 })
  const bdayBefore = (await birthday.boundingBox())!
  await dragBy(page, birthday, 0, 96)
  await page.waitForTimeout(1200)
  const bdayAfter = (await birthday.boundingBox())!
  expect(Math.abs(bdayAfter.y - bdayBefore.y)).toBeLessThan(3)

  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('link', { name: `Geburtstag ${surname}` }).click()
  await page.getByRole('button', { name: 'Delete contact' }).click()
})

test('move one occurrence of a series and leave the rest where they were', async ({ page }) => {
  test.setTimeout(120_000)
  const weekly = `Once-${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(weekly)
  await page.getByRole('combobox', { name: 'Repeat' }).selectOption('weekly')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const block = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
  await expect(block).toBeVisible({ timeout: 15_000 })
  await block.click()
  const startedAt = await page.getByLabel('Start', { exact: true }).inputValue()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // An hour down, and then the question that only a series raises.
  await dragBy(page, block, 0, 48)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'This event' }).click()
  await page.waitForTimeout(1500)

  // Reloaded, so this is what the server kept rather than what the screen did.
  await page.reload()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  const moved = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
  await expect(moved).toBeVisible({ timeout: 20_000 })
  await moved.click()
  expect(await page.getByLabel('Start', { exact: true }).inputValue()).toBe(oneHourOn(startedAt))
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Next week's occurrence is the point of the exercise: it did not move.
  await page.getByRole('button', { name: 'next' }).click()
  const untouched = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
  await expect(untouched).toBeVisible({ timeout: 10_000 })
  await untouched.click()
  expect(await page.getByLabel('Start', { exact: true }).inputValue()).toBe(startedAt)
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Delete that one occurrence only: the following week keeps its own.
  await untouched.click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await page.getByRole('button', { name: 'This event' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(weekly) }),
  ).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.getByRole('button', { name: 'next' }).click()
  await expect(
    page
      .locator('[data-testid="calendar-grid"]')
      .getByRole('button', { name: new RegExp(weekly) })
      .first(),
  ).toBeVisible({
    timeout: 10_000,
  })

  // And the series, which takes the moved occurrence with it.
  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
    .click()
  await page.getByRole('button', { name: 'Delete event' }).click()
  await page.getByRole('button', { name: 'All events' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(weekly) }),
  ).toHaveCount(0, {
    timeout: 15_000,
  })
})

test('drag a whole series onto another weekday', async ({ page }) => {
  test.setTimeout(120_000)
  const weekly = `Series-${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(weekly)
  await page.getByRole('combobox', { name: 'Repeat' }).selectOption('weekly')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const block = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
  await expect(block).toBeVisible({ timeout: 15_000 })
  await block.click()
  const startedOn = await page.getByLabel('Date', { exact: true }).inputValue()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // One column to the right, for every occurrence. The rule names the weekday
  // it repeats on, so "all events" has to rewrite that too — otherwise the
  // series goes on producing the old day and the drag appears to do nothing.
  await dragBy(page, block, (await block.boundingBox())!.width + 2, 0)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'All events' }).click()
  await page.waitForTimeout(1500)

  await page.reload()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.getByRole('button', { name: 'next' }).click()
  const nextWeek = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(weekly) })
    .first()
  await expect(nextWeek).toBeVisible({ timeout: 20_000 })
  await nextWeek.click()
  expect(await page.getByLabel('Date', { exact: true }).inputValue()).toBe(
    nextDay(weekLater(startedOn)),
  )
  await page.getByRole('button', { name: 'Delete event' }).click()
  await page.getByRole('button', { name: 'All events' }).click()
  await expect(
    page.locator('[data-testid="calendar-grid"]').getByRole('button', { name: new RegExp(weekly) }),
  ).toHaveCount(0, {
    timeout: 15_000,
  })
})

test('drag an event to another day in the month grid, then undo', async ({ page }) => {
  test.setTimeout(120_000)
  const title = `Month-${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  // A day well inside the month so the target cell exists in both directions.
  const now = new Date()
  const day = Math.min(20, Math.max(8, now.getDate()))
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Date', { exact: true }).fill(iso)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const chip = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(chip).toBeVisible({ timeout: 15_000 })

  // The grid starts on the Monday on/before the 1st, so the cell index is
  // arithmetic rather than something to hunt for in the DOM.
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const startOffset = (firstOfMonth.getDay() + 6) % 7
  const sourceIndex = startOffset + (day - 1)
  const cells = page.locator('.grid-rows-6 > div')

  await chip.dragTo(cells.nth(sourceIndex + 2))
  await page.waitForTimeout(1500)

  await chip.click()
  const movedTo = await page.getByLabel('Date', { exact: true }).inputValue()
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(movedTo).not.toBe(iso)

  // Undo puts it back.
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForTimeout(1500)
  await page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click()
  const undone = await page.getByLabel('Date', { exact: true }).inputValue()
  expect(undone).toBe(iso)

  await page.getByRole('button', { name: 'Delete event' }).click()
})

test('the sidebar search narrows the upcoming list, and clicking a hit jumps the grid to it', async ({
  page,
}) => {
  const title = `CalSearch-${Date.now() % 100000}`

  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  await page.getByRole('button', { name: 'New event' }).click()
  await page.getByPlaceholder('Title').fill(title)
  await page.getByLabel('Date', { exact: true }).fill(randomNextMonthDate(20))
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // The upcoming list looks ahead regardless of the grid's own month, so the
  // new event shows there without navigating the grid at all. Scoped to the
  // sidebar: the created date can fall inside the grid's own visible month
  // too, and its chip there matches the same name.
  const hit = page
    .locator('[data-testid="calendar-sidebar"]')
    .getByRole('button', { name: new RegExp(title) })
  await expect(hit).toBeVisible({ timeout: 10_000 })

  await page.getByPlaceholder('Search upcoming events').fill('nothing-matches-this')
  await expect(hit).toHaveCount(0)
  await expect(page.getByText('No matches')).toBeVisible()

  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByPlaceholder('Search upcoming events')).toHaveValue('')
  await expect(hit).toBeVisible()

  await hit.click()
  const chip = page
    .locator('[data-testid="calendar-grid"]')
    .getByRole('button', { name: new RegExp(title) })
    .first()
  await expect(chip).toBeVisible({ timeout: 10_000 })

  await chip.click()
  await page.getByRole('button', { name: 'Delete event' }).click()
})

test('the sidebar can be resized, and the width survives a reload', async ({ page }) => {
  await login(page)
  await page.getByRole('link', { name: 'Calendar' }).first().click()

  const sidebar = page.locator('[data-testid="calendar-sidebar"]')
  const handle = page.getByRole('separator', { name: 'Calendar list width' })
  await expect(handle).toBeVisible()

  const before = (await sidebar.boundingBox())!
  const grip = (await handle.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + 80, grip.y + grip.height / 2, { steps: 10 })
  await page.mouse.up()

  const after = (await sidebar.boundingBox())!
  expect(after.width).toBeGreaterThan(before.width + 40)

  await page.reload()
  await expect(page.getByRole('link', { name: 'Calendar' }).first()).toBeVisible()
  const reloaded = (await sidebar.boundingBox())!
  expect(Math.abs(reloaded.width - after.width)).toBeLessThan(4)

  // Shared with every other app's panel, so leave it as it was found.
  await handle.dblclick()
})
