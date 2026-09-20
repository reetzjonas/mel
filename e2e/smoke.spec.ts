import { expect, test } from '@playwright/test'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(
    page.getByRole('navigation', { name: 'Applications' }).getByRole('link'),
  ).toHaveCount(5, { timeout: 15_000 })
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const result = await page.evaluate(() => {
    const pageOverflows =
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    const scrollers = [...document.querySelectorAll<HTMLElement>('*')]
      .filter((element) => {
        const overflow = getComputedStyle(element).overflowX
        return (
          (overflow === 'auto' || overflow === 'scroll') &&
          element.clientWidth > 0 &&
          element.scrollWidth > element.clientWidth + 1 &&
          // Settings tabs and editor formatting commands deliberately scroll;
          // task surfaces must not.
          element.getAttribute('role') !== 'tablist' &&
          !element.closest('[data-horizontal-scroll="editor"]')
        )
      })
      .map((element) => ({
        tag: element.tagName,
        role: element.getAttribute('role'),
        className: element.className.toString(),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
    return { pageOverflows, scrollers }
  })
  expect(result.pageOverflows).toBe(false)
  expect(result.scrollers).toEqual([])
}

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
  if (compact) {
    await page.getByRole('button', { name: 'New contact' }).click()
    await expect(page).toHaveURL(/\/contacts\/new$/)
    await expect(page.getByLabel('First name')).toBeVisible()
    await expectNoPageOverflow()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/contacts$/)
  }
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await expect(page).toHaveURL(/\/calendar$/)
  await expectNoPageOverflow()
  if (compact) {
    await page.getByRole('button', { name: 'New event' }).click()
    const eventDialog = page.getByRole('dialog', { name: 'New event' })
    await expect(eventDialog).toBeVisible()
    await expect(eventDialog).toHaveCSS('width', '320px')
    await expect(eventDialog).toHaveCSS('height', '720px')
    for (const name of ['Cancel', 'Save']) {
      const box = await eventDialog.getByRole('button', { name }).boundingBox()
      // Mobile emulation can return a fractional box just below the 44 CSS px
      // minimum because of device-scale rounding.
      expect(box?.width).toBeGreaterThanOrEqual(43.5)
      expect(box?.height).toBeGreaterThanOrEqual(43.5)
    }
    await eventDialog.getByRole('button', { name: 'Cancel' }).click()
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
      if (name === 'Mail') {
        await page.getByRole('button', { name: 'New message', exact: true }).click()
        const compose = page.getByRole('dialog', { name: 'New message' })
        await expect(compose).toBeVisible()
        await expect(compose).toHaveCSS('width', '320px')
        await expect(compose).toHaveCSS('height', '720px')
        for (const action of ['Discard', 'Send', 'Cc', 'Bcc']) {
          const box = await compose.getByRole('button', { name: action, exact: true }).boundingBox()
          expect(box?.width).toBeGreaterThanOrEqual(43.5)
          expect(box?.height).toBeGreaterThanOrEqual(43.5)
        }
        await page.goBack()
        await expect(compose).toBeHidden()
        await expect(page).toHaveURL(/\/mail(?:\/.*)?$/)

        // The visible close action consumes the same modal history level.
        await page.getByRole('button', { name: 'New message', exact: true }).click()
        await expect(compose).toBeVisible()
        await compose.getByRole('button', { name: 'Discard' }).click()
        await expect(compose).toBeHidden()
        await expect(page).toHaveURL(/\/mail(?:\/.*)?$/)
      }
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

test('all app surfaces fit the responsive width matrix in both themes', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One browser can exercise every CSS viewport')
  await login(page)

  const widths = [320, 375, 768, 1024, 1440, 1920]
  const apps = [
    ['Mail', /\/mail(?:\/.*)?$/],
    ['Calendar', /\/calendar$/],
    ['Contacts', /\/contacts$/],
    ['Files', /\/files(?:\/.*)?$/],
    ['Notes', /\/notes$/],
  ] as const

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((preference) => {
      localStorage.setItem('mel:theme', preference)
      window.dispatchEvent(new Event('mel:theme-preference'))
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

    for (const width of widths) {
      await page.setViewportSize({ width, height: width >= 1024 ? 900 : 720 })
      for (const [name, path] of apps) {
        await page.getByRole('link', { name, exact: true }).first().click()
        await expect(page).toHaveURL(path)
        await expectNoHorizontalOverflow(page)
      }

      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      const settingsTabs = page.getByRole('tablist', { name: 'Settings' })
      await expect(settingsTabs).toHaveAttribute(
        'aria-orientation',
        width < 640 ? 'horizontal' : 'vertical',
      )
      await settingsTabs.getByRole('tab', { name: 'General' }).focus()
      await page.keyboard.press(width < 640 ? 'ArrowRight' : 'ArrowDown')
      await expect(settingsTabs.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      await page.getByRole('button', { name: 'Close settings' }).click()
    }
  }
})
