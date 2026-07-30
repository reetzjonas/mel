import { expect, test } from '@playwright/test'

test('app shell renders and redirects to /mail (login form without account)', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/mail$/)
  await expect(page.getByRole('heading', { name: 'Add account' })).toBeVisible()
})

test('app switcher navigates between apps', async ({ page }) => {
  await page.goto('/mail')
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await expect(page).toHaveURL(/\/contacts$/)
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await expect(page).toHaveURL(/\/calendar$/)
})
