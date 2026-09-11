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

test('create, rename and delete a folder', async ({ page }) => {
  const name = `Folder-${Date.now() % 100000}`
  await login(page)

  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.locator('form input').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  const folder = page.getByRole('link', { name })
  await expect(folder).toBeVisible({ timeout: 10_000 })

  await folder.hover()
  await folder.getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.locator('form input').fill(`${name}-neu`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const renamed = page.getByRole('link', { name: `${name}-neu` })
  await expect(renamed).toBeVisible({ timeout: 10_000 })

  page.on('dialog', (d) => void d.accept())
  await renamed.hover()
  await renamed.getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('button', { name: 'Delete folder' }).click()
  await expect(page.getByRole('link', { name: `${name}-neu` })).toHaveCount(0, {
    timeout: 10_000,
  })
})

/*
 * Dragging one folder onto another re-parents it, and the account row stands
 * for the top level — without a target for that, a folder could be dragged in
 * and never out, since every other one is a folder. The menu keeps offering
 * both, for keyboard and touch.
 */
test('dragging a folder nests it, and the account row lifts it back out', async ({ page }) => {
  test.setTimeout(60_000)
  const stamp = Date.now() % 100000
  const child = `Drag-${stamp}`
  const parent = `Ziel-${stamp}`
  await login(page)

  for (const name of [child, parent]) {
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.locator('form input').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('link', { name })).toBeVisible({ timeout: 10_000 })
  }

  // Nested rows are indented; the padding is what says it worked.
  const indent = async () =>
    page.getByRole('link', { name: child }).evaluate((el) => getComputedStyle(el).paddingLeft)
  const before = await indent()

  await page.getByRole('link', { name: child }).dragTo(page.getByRole('link', { name: parent }))
  await expect.poll(indent, { timeout: 15_000 }).not.toBe(before)

  // And back out, onto the account row, which stands for the top level.
  await page
    .getByRole('link', { name: child })
    .dragTo(page.getByText('alice@localhost', { exact: true }))
  await expect.poll(indent, { timeout: 15_000 }).toBe(before)

  page.on('dialog', (d) => void d.accept())
  for (const name of [child, parent]) {
    const row = page.getByRole('link', { name })
    await row.hover()
    await row.getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('button', { name: 'Delete folder' }).click()
    await expect(page.getByRole('link', { name })).toHaveCount(0, { timeout: 10_000 })
  }
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
  await page.getByRole('button', { name: 'Discard' }).click()

  await page.getByRole('link', { name: 'Drafts' }).click()
  await expect(page.getByText(subject)).toBeVisible({ timeout: 10_000 })
})

/*
 * The point of a draft: picking it back up. Before this, a saved draft could
 * only be looked at in the reading pane — the fields were gone, so the message
 * could neither be finished nor sent, only deleted.
 */
test('reopen a saved draft, finish it and send it', async ({ page }) => {
  test.setTimeout(60_000)
  const subject = `Weiter-${Date.now() % 100000}`
  await login(page)

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Erster Satz.')
  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Discard' }).click()

  await page.getByRole('link', { name: 'Drafts' }).click()
  const row = page.getByText(subject)
  await expect(row).toBeVisible({ timeout: 10_000 })

  // The draft opens like any other message; the editor is one deliberate click
  // further, on the button the reading pane offers instead of Reply.
  await row.click()
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit draft' }).click()
  await expect(page.getByPlaceholder('To', { exact: true })).toHaveValue(/bob@localhost/)
  await expect(page.getByPlaceholder('Subject', { exact: true })).toHaveValue(subject)
  await expect(page.locator('.ProseMirror')).toContainText('Erster Satz.')

  await page.locator('.ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Zweiter Satz.')

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Sending in 10 s')).toBeVisible({ timeout: 10_000 })
  // Sending takes the draft with it: the message it was is gone from Drafts,
  // and no second copy is left behind by the autosave that created it.
  await expect(page.getByText(subject)).toHaveCount(0, { timeout: 20_000 })
})

/*
 * The autosave waits 2.5 s after the last change and says nothing until it
 * fires, so closing the window inside that gap dropped the edit silently.
 * Saving on demand is the answer, and it has to write into the draft the
 * window already owns rather than leaving a second copy behind.
 */
test('save a draft on demand, into the same message', async ({ page }) => {
  test.setTimeout(60_000)
  const subject = `Speichern-${Date.now() % 100000}`
  await login(page)

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Erster Satz.')

  // Unsaved until it is saved, and the footer says so rather than showing a
  // stale "Draft saved" over edits that are not on the server.
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Discard' }).click()

  const drafts = page.getByRole('link', { name: 'Drafts' })
  await drafts.click()
  const rows = page.getByTestId('thread-subject').filter({ hasText: subject })
  await expect(rows).toHaveCount(1, { timeout: 10_000 })

  // Reopen, edit, save again: still one draft, carrying the newer text.
  await rows.first().click()
  const openedAt = page.url()
  await page.getByRole('button', { name: 'Edit draft' }).click()
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Zweiter Satz.')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })

  /*
   * Saving is create-plus-destroy (an Email is immutable), so the draft comes
   * back under a new id and the pane behind this window is routed to one the
   * next sync deletes — it emptied out mid-edit. The URL following along is
   * the race-free way to see that it did not: waiting for the pane to go blank
   * only ever proves the assertion beat the sync.
   */
  await expect.poll(() => page.url(), { timeout: 15_000 }).not.toBe(openedAt)
  await page.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText('Message not found')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: subject })).toBeVisible({ timeout: 15_000 })

  await page.getByRole('link', { name: 'Inbox' }).click()
  await drafts.click()
  await expect(rows).toHaveCount(1, { timeout: 10_000 })
  await rows.first().click()
  await page.getByRole('button', { name: 'Edit draft' }).click()
  await expect(page.locator('.ProseMirror')).toContainText('Zweiter Satz.')

  await page.getByRole('button', { name: 'Delete draft' }).click()
  await expect(page.getByText('Draft deleted')).toBeVisible({ timeout: 10_000 })
})

/* Throwing a draft away from inside the editor, which is where you are when
 * you decide it is not worth finishing. */
test('delete a draft from the compose window', async ({ page }) => {
  const subject = `Weg-${Date.now() % 100000}`
  await login(page)

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Doch nicht.')
  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'Delete draft' }).click()
  await expect(page.getByText('Draft deleted')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('link', { name: 'Drafts' }).click()
  await expect(page.getByText(subject)).toHaveCount(0, { timeout: 10_000 })
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

  const boxes = (await call([['Mailbox/get', { accountId: 'c', ids: null }, 'c0']]))
    .methodResponses[0]![1] as unknown as { list: Array<{ id: string; name: string }> }
  const target = boxes.list.find((b) => b.name === mailboxName)!
  const inbox = boxes.list.find((b) => b.name === 'Inbox')!

  const q = (
    await call([
      ['Email/query', { accountId: 'c', filter: { inMailbox: inbox.id }, limit: 1 }, 'c0'],
    ])
  ).methodResponses[0]![1] as unknown as { ids: string[] }
  await call([
    [
      'Email/set',
      { accountId: 'c', update: { [q.ids[0]!]: { [`mailboxIds/${target.id}`]: true } } },
      'c0',
    ],
  ])
}

test('delete a folder that has a subfolder and still holds mail', async ({ page }) => {
  test.setTimeout(60_000)
  const parent = `Parent-${Date.now() % 100000}`
  const child = `${parent}-sub`

  await login(page)

  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.locator('form input').fill(parent)
  await page.getByRole('button', { name: 'Create' }).click()
  // Not `exact`: a folder row's accessible name gains the unread counter as
  // soon as it holds unread mail, which it does on a freshly seeded server.
  // Anchored regex instead, so the name still cannot match the subfolder.
  const folderRow = (name: string) =>
    page.getByRole('link', { name: new RegExp(`^${name}( \\d+)?$`) })
  const parentRow = folderRow(parent)
  await expect(parentRow).toBeVisible({ timeout: 10_000 })

  // A subfolder alone already makes the server refuse the delete
  // (mailboxHasChild), and mail inside refuses again (mailboxHasEmail).
  await parentRow.hover()
  await parentRow.getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('button', { name: 'New subfolder' }).click()
  await page.locator('form input').fill(child)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(folderRow(child)).toBeVisible({ timeout: 10_000 })

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
  await parentRow.getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('button', { name: 'Delete folder' }).click()

  await expect(folderRow(parent)).toHaveCount(0, { timeout: 15_000 })
  await expect(folderRow(child)).toHaveCount(0)
  expect(prompt).toContain('subfolders')
  expect(prompt).toContain('mail')

  // Filed in the inbox as well, so it loses the folder and nothing more.
  await expect(page.getByText('Willkommen bei mel').first()).toBeVisible({ timeout: 15_000 })
})

test('move a folder under another one, and back to the top level', async ({ page }) => {
  test.setTimeout(60_000)
  const outer = `Outer-${Date.now() % 100000}`
  const inner = `Inner-${Date.now() % 100000}`

  await login(page)
  for (const name of [outer, inner]) {
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.locator('form input').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('link', { name: new RegExp(`^${name}( \\d+)?$`) })).toBeVisible({
      timeout: 10_000,
    })
  }

  const row = (name: string) => page.getByRole('link', { name: new RegExp(`^${name}( \\d+)?$`) })
  const indentOf = async (name: string) =>
    row(name).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))

  const flat = await indentOf(inner)

  await row(inner).hover()
  await row(inner).getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('button', { name: 'Move to…' }).click()
  // Not itself, and not a role folder: Inbox and friends mean something to the
  // server and to other clients, so user folders do not get nested inside them.
  await expect(page.getByRole('button', { name: inner, exact: true })).toHaveCount(0)
  for (const role of ['Inbox', 'Deleted Items', 'Drafts', 'Sent Items', 'Junk Mail']) {
    await expect(page.getByRole('button', { name: role, exact: true })).toHaveCount(0)
  }
  await page.getByRole('button', { name: outer, exact: true }).click()

  // Nesting is visible as indentation, which is what the tree ordering produces.
  await expect.poll(() => indentOf(inner), { timeout: 15_000 }).toBeGreaterThan(flat)

  await row(inner).hover()
  await row(inner).getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('button', { name: 'Move to…' }).click()
  await page.getByRole('button', { name: 'Top level' }).click()
  await expect.poll(() => indentOf(inner), { timeout: 15_000 }).toBe(flat)

  // Clean up both folders.
  for (const name of [inner, outer]) {
    page.once('dialog', (d) => void d.accept())
    await row(name).hover()
    await row(name).getByRole('button', { name: 'Folder actions' }).click()
    await page.getByRole('button', { name: 'Delete folder' }).click()
    await expect(row(name)).toHaveCount(0, { timeout: 15_000 })
  }
})
