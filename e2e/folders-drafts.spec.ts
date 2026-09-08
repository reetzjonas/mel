import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Inbox')).toBeVisible({ timeout: 15_000 })
}

test('create, rename and delete a folder', async ({ page }) => {
  const name = `Folder-${Date.now() % 100000}`
  await login(page)

  await page.getByTitle('New folder').click()
  await page.locator('form input').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  const folder = page.getByRole('link', { name })
  await expect(folder).toBeVisible({ timeout: 10_000 })

  await folder.hover()
  await folder.getByTitle('Folder actions').click()
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.locator('form input').fill(`${name}-neu`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const renamed = page.getByRole('link', { name: `${name}-neu` })
  await expect(renamed).toBeVisible({ timeout: 10_000 })

  page.on('dialog', (d) => void d.accept())
  await renamed.hover()
  await renamed.getByTitle('Folder actions').click()
  await page.getByRole('button', { name: 'Delete folder' }).click()
  await expect(page.getByRole('link', { name: `${name}-neu` })).toHaveCount(0, {
    timeout: 10_000,
  })
})

test('compose autosaves a draft into the Drafts folder', async ({ page }) => {
  const subject = `Entwurf-${Date.now() % 100000}`
  await login(page)

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Angefangener Text…')

  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })
  // Close without sending; the draft stays on the server.
  await page.getByTitle('Discard').click()

  await page.getByRole('link', { name: 'Drafts' }).click()
  await expect(page.getByText(subject)).toBeVisible({ timeout: 10_000 })
})

/*
 * Files an existing message into an extra mailbox without taking it out of the
 * inbox. The UI's move replaces the mailbox set, which would leave the message
 * living only in the folder under test — deleting that folder would then
 * destroy a seeded mail for good and break the other specs.
 */
async function alsoFileInto(mailboxName: string): Promise<void> {
  const auth =
    'Basic ' + Buffer.from('alice@localhost:korrekt-pferd-batterie-alice').toString('base64')
  const call = async (methodCalls: unknown[]) => {
    const res = await fetch('http://localhost:8080/jmap/', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls,
      }),
    })
    return (await res.json()) as { methodResponses: Array<[string, Record<string, never>, string]> }
  }

  const boxes = (
    await call([['Mailbox/get', { accountId: 'c', ids: null }, 'c0']])
  ).methodResponses[0]![1] as unknown as { list: Array<{ id: string; name: string }> }
  const target = boxes.list.find((b) => b.name === mailboxName)!
  const inbox = boxes.list.find((b) => b.name === 'Inbox')!

  const q = (
    await call([
      ['Email/query', { accountId: 'c', filter: { inMailbox: inbox.id }, limit: 1 }, 'c0'],
    ])
  ).methodResponses[0]![1] as unknown as { ids: string[] }
  await call([
    ['Email/set', { accountId: 'c', update: { [q.ids[0]!]: { [`mailboxIds/${target.id}`]: true } } }, 'c0'],
  ])
}

test('delete a folder that has a subfolder and still holds mail', async ({ page }) => {
  test.setTimeout(60_000)
  const parent = `Parent-${Date.now() % 100000}`
  const child = `${parent}-sub`

  await login(page)

  await page.getByTitle('New folder').click()
  await page.locator('form input').fill(parent)
  await page.getByRole('button', { name: 'Create' }).click()
  const parentRow = page.getByRole('link', { name: parent, exact: true })
  await expect(parentRow).toBeVisible({ timeout: 10_000 })

  // A subfolder alone already makes the server refuse the delete
  // (mailboxHasChild), and mail inside refuses again (mailboxHasEmail).
  await parentRow.hover()
  await parentRow.getByTitle('Folder actions').click()
  await page.getByRole('button', { name: 'New subfolder' }).click()
  await page.locator('form input').fill(child)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('link', { name: child, exact: true })).toBeVisible({
    timeout: 10_000,
  })

  await alsoFileInto(parent)
  await page.reload()
  await expect(parentRow).toBeVisible({ timeout: 15_000 })

  // One confirmation that spells out both consequences, then it just works.
  let prompt = ''
  page.once('dialog', (d) => {
    prompt = d.message()
    void d.accept()
  })
  await parentRow.hover()
  await parentRow.getByTitle('Folder actions').click()
  await page.getByRole('button', { name: 'Delete folder' }).click()

  await expect(page.getByRole('link', { name: parent, exact: true })).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(page.getByRole('link', { name: child, exact: true })).toHaveCount(0)
  expect(prompt).toContain('subfolders')
  expect(prompt).toContain('mail')

  // Filed in the inbox as well, so it loses the folder and nothing more.
  await expect(page.getByText('Willkommen bei mel').first()).toBeVisible({ timeout: 15_000 })
})
