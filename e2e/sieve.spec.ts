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

/**
 * The filter rules section, scoped.
 *
 * The Mail tab also carries the vacation response, which has a Save button of
 * its own — an unscoped `{ name: 'Save' }` matches both.
 */
async function openFilterRules(page: Page) {
  await page.goto('/mail?settings=mail')
  const section = page.locator('section').filter({ hasText: 'Filter rules' })
  await expect(section.getByRole('heading', { name: 'Filter rules' })).toBeVisible({
    timeout: 15_000,
  })
  return section
}

const SCRIPT =
  'require ["fileinto"];\nif header :contains "subject" "mel-e2e" {\n  fileinto "INBOX";\n}\n'

test('build a rule in the form, and the server accepts what it generated', async ({ page }) => {
  const name = `wiz-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  const rules = await openFilterRules(page)

  await rules.getByRole('button', { name: 'New rule set' }).click()
  await rules.getByLabel('Name', { exact: true }).fill(name)

  // A new rule set opens on the form, not on a blank script: someone who
  // cannot write Sieve has to be able to get somewhere from here.
  await rules.getByLabel('Rule name').fill('Newsletters')
  // A quote in the value is the case that breaks a naive generator: it would
  // close the Sieve string and the rest of the rule would become syntax.
  await rules.getByLabel('Value').fill('news "weekly" digest')
  // No folder is preselected — choosing one for the user would be a guess
  // about where their mail should go.
  await rules.getByLabel('Folder').selectOption({ index: 1 })

  await rules.getByRole('button', { name: 'Check' }).click()
  await expect(rules.getByRole('status')).toContainText('The script is valid.', {
    timeout: 15_000,
  })

  await rules.getByRole('button', { name: 'Save and use' }).click()
  const row = rules.getByRole('listitem').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 15_000 })

  // Reopening comes back as the form, with the value intact — the round trip
  // the marker line exists for.
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(rules.getByLabel('Value')).toHaveValue('news "weekly" digest')

  // ...and the generated script is there to look at.
  await rules.getByRole('button', { name: 'Edit as text' }).click()
  await expect(rules.getByLabel('Sieve script')).toHaveValue(/fileinto/)
  await rules.getByRole('button', { name: 'Cancel' }).click()

  await row.getByRole('button', { name: 'Switch filtering off' }).click()
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(rules.getByRole('listitem').filter({ hasText: name })).toHaveCount(0, {
    timeout: 15_000,
  })
})

test('filtering from an open message opens a rule for its sender', async ({ page }) => {
  page.on('dialog', (d) => void d.accept())
  await login(page)

  // Open a seeded message and ask for a rule like it.
  await page.getByText('Willkommen bei mel').first().click()
  await page.getByRole('button', { name: 'Filter messages like this' }).click()

  const rules = page.locator('section').filter({ hasText: 'Filter rules' })
  await expect(rules.getByRole('heading', { name: 'Filter rules' })).toBeVisible({
    timeout: 15_000,
  })
  // Straight into the form, with the sender already matched — that is the
  // whole point of starting from the message rather than from settings.
  const sender = await rules.getByLabel('Value').inputValue()
  expect(sender).toContain('@')
  await expect(rules.getByLabel('Rule name')).toHaveValue(sender)

  // No folder is chosen for the user, and saving without one is refused
  // rather than silently writing a rule that does nothing.
  await rules.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rules.getByRole('status')).toContainText('Pick a folder')

  await rules.getByLabel('Folder').selectOption({ index: 1 })
  await rules.getByRole('button', { name: 'Check' }).click()
  await expect(rules.getByRole('status')).toContainText('The script is valid.', {
    timeout: 15_000,
  })

  await rules.getByRole('button', { name: 'Cancel' }).click()
  await expect(rules.getByRole('button', { name: 'New rule set' })).toBeVisible()
})

test('a hand-written script is offered as text, not rewritten by the form', async ({ page }) => {
  const name = `hand-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  const rules = await openFilterRules(page)

  await rules.getByRole('button', { name: 'New rule set' }).click()
  await rules.getByLabel('Name', { exact: true }).fill(name)
  await rules.getByRole('button', { name: 'Edit as text' }).click()
  await rules.getByLabel('Sieve script').fill(SCRIPT)
  await rules.getByRole('button', { name: 'Save', exact: true }).click()

  const row = rules.getByRole('listitem').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 15_000 })

  // Saved from the text editor, so the marker is gone and the form must not
  // claim it can show this script — reopening it in the form would rewrite it.
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(rules.getByText('not written by the form')).toBeVisible()
  await expect(rules.getByLabel('Sieve script')).toHaveValue(/mel-e2e/)
  await rules.getByRole('button', { name: 'Cancel' }).click()

  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(rules.getByRole('listitem').filter({ hasText: name })).toHaveCount(0, {
    timeout: 15_000,
  })
})

test('write a rule set, have the server check it, activate and delete it', async ({ page }) => {
  const name = `e2e-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  const rules = await openFilterRules(page)

  await rules.getByRole('button', { name: 'New rule set' }).click()
  await rules.getByLabel('Name', { exact: true }).fill(name)
  // The text editor is behind the form now, which is where a new set opens.
  await rules.getByRole('button', { name: 'Edit as text' }).click()

  // A script the server refuses: the point of the editor is that the error
  // comes from the server's own parser, with the line in it.
  await rules.getByLabel('Sieve script').fill('if header :contains "subject" {\n')
  await rules.getByRole('button', { name: 'Check' }).click()
  await expect(rules.getByRole('status')).toContainText(/line/i, { timeout: 15_000 })

  await rules.getByLabel('Sieve script').fill(SCRIPT)
  await rules.getByRole('button', { name: 'Check' }).click()
  await expect(rules.getByRole('status')).toContainText('The script is valid.', {
    timeout: 15_000,
  })

  await rules.getByRole('button', { name: 'Save and use' }).click()
  const row = rules.getByRole('listitem').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('Active')

  // Reopening has to show what the server stored, not what was typed — the
  // script text comes back down as a blob.
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(rules.getByLabel('Sieve script')).toHaveValue(/fileinto "INBOX"/)
  await rules.getByRole('button', { name: 'Cancel' }).click()

  // The active script cannot be deleted, and saying so is the useful part.
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(rules.getByRole('status')).toContainText('Switch this rule set off', {
    timeout: 15_000,
  })

  await row.getByRole('button', { name: 'Switch filtering off' }).click()
  await expect(row).not.toContainText('Active', { timeout: 15_000 })
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(rules.getByRole('listitem').filter({ hasText: name })).toHaveCount(0, {
    timeout: 15_000,
  })
})
