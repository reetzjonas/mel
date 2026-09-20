import { expect, test } from '@playwright/test'

test('app shell renders and redirects to /mail (login form without account)', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/mail$/)
  await expect(page.getByRole('heading', { name: 'Add account' })).toBeVisible()
})

test('app switcher navigates between apps (after login)', async ({ page }) => {
  await page.goto('/mail')
  // Without an account only Mail is offered (apps are capability-gated).
  await expect(page.getByRole('link', { name: 'Contacts' })).toHaveCount(0)

  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()

  const compact = (page.viewportSize()?.width ?? 0) < 640
  if (compact) await page.setViewportSize({ width: 320, height: 720 })
  const expectNoPageOverflow = async () =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false)

  const appNavigation = page.getByRole('navigation', { name: 'Applications' })
  await expect(appNavigation.getByRole('link')).toHaveCount(5, { timeout: 15_000 })
  // Settings is a utility in the compact app header, not a sixth destination
  // squeezed into the phone's bottom application bar.
  if (compact) {
    await expect(appNavigation.getByRole('button', { name: 'Settings' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  }

  await page.getByRole('link', { name: 'Contacts' }).first().click({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/contacts$/)
  await expectNoPageOverflow()
  if (compact) await expect(page.getByRole('button', { name: 'New contact' })).toBeVisible()
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await expect(page).toHaveURL(/\/calendar$/)
  await expectNoPageOverflow()
  if (compact) {
    await expect(page.getByRole('button', { name: 'New event' })).toBeVisible()
    await page.getByRole('button', { name: 'Calendars', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Calendars' })).toBeVisible()
    await page.getByRole('button', { name: 'Close calendars' }).click()
  }

  for (const [name, path] of [
    ['Files', '/files'],
    ['Notes', '/notes'],
    ['Mail', '/mail'],
  ] as const) {
    await page.getByRole('link', { name, exact: true }).first().click()
    await expect(page).toHaveURL(new RegExp(`${path}(?:/.*)?$`))
    await expectNoPageOverflow()
    if (compact) {
      const primary = { Files: 'Upload', Notes: 'New note', Mail: 'New message' }[name]
      await expect(page.getByRole('button', { name: primary, exact: true })).toBeVisible()
    }
    if (compact && name === 'Files') {
      await page.getByRole('button', { name: 'More file actions' }).click()
      const menu = page.getByRole('menu', { name: 'More file actions' })
      await expect(menu.getByRole('menuitem', { name: 'New folder' })).toBeVisible()
      await expect(menu.getByRole('menuitemcheckbox', { name: 'Show hidden files' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    }
  }
})
