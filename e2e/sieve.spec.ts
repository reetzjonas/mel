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

async function openFilterRules(page: Page) {
  await page.goto('/mail?settings=mail')
  await expect(page.getByRole('heading', { name: 'Filter rules' })).toBeVisible({
    timeout: 15_000,
  })
}

const SCRIPT =
  'require ["fileinto"];\nif header :contains "subject" "mel-e2e" {\n  fileinto "INBOX";\n}\n'

test('write a rule set, have the server check it, activate and delete it', async ({ page }) => {
  const name = `e2e-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await openFilterRules(page)

  await page.getByRole('button', { name: 'New rule set' }).click()
  await page.getByLabel('Name').fill(name)

  // A script the server refuses: the point of the editor is that the error
  // comes from the server's own parser, with the line in it.
  await page.getByLabel('Sieve script').fill('if header :contains "subject" {\n')
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByRole('status')).toContainText(/line/i, { timeout: 15_000 })

  await page.getByLabel('Sieve script').fill(SCRIPT)
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByRole('status')).toContainText('The script is valid.', {
    timeout: 15_000,
  })

  await page.getByRole('button', { name: 'Save and use' }).click()
  const row = page.getByRole('listitem').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('Active')

  // Reopening has to show what the server stored, not what was typed — the
  // script text comes back down as a blob.
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByLabel('Sieve script')).toHaveValue(/fileinto "INBOX"/)
  await page.getByRole('button', { name: 'Cancel' }).click()

  // The active script cannot be deleted, and saying so is the useful part.
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('status')).toContainText('Switch this rule set off', {
    timeout: 15_000,
  })

  await row.getByRole('button', { name: 'Switch filtering off' }).click()
  await expect(row).not.toContainText('Active', { timeout: 15_000 })
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0, {
    timeout: 15_000,
  })
})
