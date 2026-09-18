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

/** A small PNG made in the page, so the test carries no binary of its own. */
async function picture(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 120
    c.height = 80
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#0e9488'
    ctx.fillRect(0, 0, 120, 80)
    return c.toDataURL('image/png').split(',')[1]!
  })
  return Buffer.from(base64, 'base64')
}

test('write a note, tick an item off, and find it again after a reload', async ({ page }) => {
  test.setTimeout(120_000)
  const title = `Einkauf-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('button', { name: 'New note' }).click()

  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  const body = page.getByRole('textbox', { name: 'Note', exact: true })
  await body.click()
  // Typed, not filled: the editor is a document, and Enter on a list line
  // continues the list the way the markdown keymap does it.
  await page.keyboard.type('- [ ] Milch\nBrot')

  /*
   * A reload is the whole assertion: the note is written to a file on the
   * server through the outbox, and a fresh page has nothing to go on but what
   * came back from it.
   */
  await page.waitForTimeout(3000)
  await page.reload()
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('link', { name: title }).click()

  // The checkbox is drawn over the `- [ ]` in the text; ticking it rewrites
  // that line, and the file with it.
  const milch = page.getByRole('checkbox', { name: 'Milch' })
  await expect(milch).toBeVisible({ timeout: 20_000 })
  await expect(milch).not.toBeChecked()
  await milch.click()
  await expect(milch).toBeChecked({ timeout: 10_000 })
  await page.waitForTimeout(3000)
  await page.reload()
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByRole('checkbox', { name: 'Milch' })).toBeChecked({ timeout: 20_000 })

  // Cleanup: the note is a folder, and deleting it takes the folder with it.
  await page.getByRole('link', { name: title }).click()
  await page.getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByRole('link', { name: title })).toHaveCount(0, { timeout: 15_000 })
})

test('a picture in a note is a file beside it, and survives a reload', async ({ page }) => {
  test.setTimeout(120_000)
  const title = `Bild-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill(title)

  await page.locator('input[type="file"]').setInputFiles({
    name: 'zettel.png',
    mimeType: 'image/png',
    buffer: await picture(page),
  })
  // Drawn under the line that refers to it, from the copy staged locally.
  await expect(page.getByRole('img', { name: 'zettel.png' })).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(3000)

  await page.reload()
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('link', { name: title }).click()
  // Fetched back from the server as a file of its own: the staged copy was
  // dropped when it was uploaded, so this image is the one that round-tripped.
  const shown = page.getByRole('img', { name: 'zettel.png' })
  await expect(shown).toBeVisible({ timeout: 20_000 })
  expect(await shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120)

  // It is an ordinary file, so the Files app finds it in the note's folder.
  await page.getByRole('link', { name: 'Files' }).first().click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page
    .getByRole('button', { name: /^bild-/ })
    .first()
    .click()
  await expect(page.getByRole('button', { name: 'note.md', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole('button', { name: 'zettel.png', exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('link', { name: title }).click()
  await page.getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByRole('link', { name: title })).toHaveCount(0, { timeout: 15_000 })
})

test('a note written offline is waiting on the server once the connection is back', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  const title = `Zug-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Notes' }).first().click()

  /*
   * The editor is opened before the network goes, and the writing happens
   * after. Not for the app's sake but for the dev server's: route modules are
   * fetched on demand here, and one that has never been loaded cannot be
   * loaded with the network off. In the installed app the service worker has
   * them precached, which is the case this stands in for.
   *
   * Nothing is queued for an untouched note, so the folder this note lives in
   * is created only once the typing below has happened — offline.
   */
  await page.getByRole('button', { name: 'New note' }).click()
  /*
   * Waited for by the *body*, not the title: the title is part of the page,
   * while the editor under it is fetched on demand, and cutting the network in
   * between leaves the note half-open. That is the dev server's on-demand
   * modules, not the app — the installed one has them precached.
   */
  await expect(page.getByRole('textbox', { name: 'Note', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await context.setOffline(true)

  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note', exact: true }).click()
  await page.keyboard.type('kein Netz, trotzdem geschrieben')
  await expect(page.getByRole('link', { name: title })).toBeVisible()

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  // A reload has nothing local left to draw it from but what the sync brought
  // back, so finding it here is finding it on the server.
  await page.waitForTimeout(4000)
  await page.reload()
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByText('kein Netz, trotzdem geschrieben')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByRole('link', { name: title })).toHaveCount(0, { timeout: 15_000 })
})

test('the toolbar writes the markdown, and the file has it', async ({ page }) => {
  test.setTimeout(120_000)
  const title = `Werkzeug-${Date.now() % 100000}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill(title)

  const body = page.getByRole('textbox', { name: 'Note', exact: true })
  await body.click()
  await page.keyboard.type('Wochenplan')
  await page.getByRole('button', { name: 'Heading' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('\nBrot')
  // The word under the cursor, without selecting it first.
  await page.keyboard.press('Control+b')
  await page.getByRole('button', { name: 'Checklist item' }).click()

  // What the editor shows once the cursor is out of that line: a heading, a
  // checkbox, and no asterisks. (On the line being edited they are there, on
  // purpose — that is the line whose text is being changed.)
  await expect(page.getByRole('checkbox', { name: 'Brot' })).toBeVisible()
  await expect(body).toContainText('**Brot**')
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(body).not.toContainText('**')
  await page.waitForTimeout(3000)

  /*
   * And what is in the file, read through the Files app: the markers the
   * buttons wrote. This is the claim the whole editor rests on — the buffer is
   * the document, so a note formatted here is a Markdown file elsewhere.
   */
  await page.getByRole('link', { name: 'Files' }).first().click()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page
    .getByRole('button', { name: /^werkzeug-/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'note.md', exact: true }).click()
  await expect(page.getByText('## Wochenplan')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('- [ ] **Brot**')).toBeVisible()

  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('link', { name: title }).click()
  await page.getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByRole('link', { name: title })).toHaveCount(0, { timeout: 15_000 })
})

test('select several notes, pin and delete them together', async ({ page }) => {
  test.setTimeout(120_000)
  const tag = Date.now() % 100000
  const titleA = `BulkA-${tag}`
  const titleB = `BulkB-${tag}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('link', { name: 'Notes' }).first().click()

  for (const title of [titleA, titleB]) {
    await page.getByRole('button', { name: 'New note' }).click()
    // "New note" navigates asynchronously; with an editor already open (the
    // previous note in this loop) its Title box exists right up until the
    // swap, so filling the moment the button is clicked can land on the
    // outgoing note instead of the new, still-empty one.
    const titleBox = page.getByRole('textbox', { name: 'Title' })
    await expect(titleBox).toHaveValue('')
    await titleBox.fill(title)
    // Autosave debounces (AUTOSAVE_MS); navigating away before it fires
    // cancels the pending write, the same reason the other notes specs wait
    // here before moving on.
    await page.waitForTimeout(3000)
  }
  await expect(page.getByRole('link', { name: titleA })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('link', { name: titleB })).toBeVisible({ timeout: 15_000 })

  // Tick both, and the row toolbar turns into the selection one.
  await page.getByRole('checkbox', { name: `Select ${titleA}` }).click()
  await page.getByRole('checkbox', { name: `Select ${titleB}` }).click()
  await expect(page.getByText('2 selected')).toBeVisible()

  await page
    .getByTestId('selection-toolbar')
    .getByRole('button', { name: 'Pin', exact: true })
    .click()
  await page.getByRole('link', { name: titleA }).click()
  await expect(page.getByRole('button', { name: 'Pin', pressed: true })).toBeVisible()

  // Select both again and delete them together from the selection toolbar.
  await page.getByRole('checkbox', { name: `Select ${titleA}` }).click()
  await page.getByRole('checkbox', { name: `Select ${titleB}` }).click()
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Delete note' }).click()
  await expect(page.getByRole('link', { name: titleA })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole('link', { name: titleB })).toHaveCount(0)
})
