import { expect, test, type Page } from '@playwright/test'

// Requires the seeded local Stalwart (npm run stalwart:seed).
async function login(page: Page, user: string, pass: string) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill(user)
  await page.getByRole('textbox', { name: 'Password' }).fill(pass)
  await page.getByRole('button', { name: 'Connect' }).click()
}

const ALICE = ['alice@localhost', 'korrekt-pferd-batterie-alice'] as const
const BOB = ['bob@localhost', 'korrekt-pferd-batterie-bob'] as const

test('formatting toolbar output — bold, italic, a list and a link — survives to the recipient', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000)
  const subject = `e2e-format-${Date.now()}`

  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)

  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.type('Intro. ')

  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type('bold')
  await page.getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.type(' ')
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.keyboard.type('italic')
  await page.getByRole('button', { name: 'Italic' }).click()
  await page.keyboard.press('Enter')

  await page.getByRole('button', { name: 'Bulleted list' }).click()
  await expect(page.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.type('list item')

  // A link on freshly typed text: select it, then enter the URL in the dialog.
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Bulleted list' }).click() // leave the list
  await page.keyboard.type('a link')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await page.getByRole('button', { name: 'Add link' }).click()
  await page
    .getByRole('dialog', { name: 'Add link' })
    .getByRole('textbox')
    .fill('https://example.com')
  await page.getByRole('dialog', { name: 'Add link' }).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Remove link' })).toBeVisible()

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sending in 10 s')).toBeVisible()
  // The snackbar disappears when the undo window expires and sending begins.
  // Waiting for that state avoids guessing how long the browser timer needs.
  await expect(page.getByText('Sending in 10 s')).toBeHidden({ timeout: 20_000 })

  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await login(bobPage, ...BOB)
  await expect(bobPage.getByText(subject)).toBeVisible({ timeout: 30_000 })
  await bobPage.getByText(subject).click()
  const frame = bobPage.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('bold', { exact: true })).toBeVisible()
  await expect(frame.locator('strong', { hasText: 'bold' })).toBeVisible()
  await expect(frame.locator('em', { hasText: 'italic' })).toBeVisible()
  await expect(frame.locator('li', { hasText: 'list item' })).toBeVisible()
  const link = frame.getByRole('link', { name: 'a link' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', 'https://example.com')
  await bobCtx.close()
})

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

/** The MIME structure of bob's newest message with this subject, read behind the app's back. */
async function bodyStructureFor(subject: string): Promise<Record<string, unknown> | null> {
  const base = 'http://localhost:8080'
  const auth = 'Basic ' + Buffer.from(`${BOB[0]}:${BOB[1]}`).toString('base64')
  const session = await (
    await fetch(`${base}/.well-known/jmap`, { headers: { Authorization: auth } })
  ).json()
  const accountId = Object.keys(session.accounts)[0]!
  const res = await (
    await fetch(`${base}/jmap/`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Email/query', { accountId, filter: { subject } }, 'q'],
          [
            'Email/get',
            {
              accountId,
              '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
              properties: ['bodyStructure'],
            },
            'g',
          ],
        ],
      }),
    })
  ).json()
  return res.methodResponses[1][1].list[0]?.bodyStructure ?? null
}

/*
 * Issue #9, the interop half: a picture put into the text has to reach the
 * other side as a real inline part — multipart/related, with the HTML
 * pointing at its Content-ID — and be drawn there rather than listed as a
 * file. A file attached beside it stays a file.
 */
test('a picture in the text arrives inline, a file beside it as an attachment', async ({
  page,
  browser,
  isMobile,
}) => {
  test.skip(isMobile, 'sends mail; the desktop run covers it')
  test.setTimeout(90_000)
  const subject = `e2e-inline-${Date.now()}`

  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.type('Look at this: ')

  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Insert picture' }).click()
  await (
    await chooser
  ).setFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: await picture(page),
  })
  const inEditor = editor.locator('img.compose-inline-image')
  await expect(inEditor).toBeVisible()
  await expect.poll(() => inEditor.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(120)

  const fileChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach file' }).click()
  await (
    await fileChooser
  ).setFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('beside the text'),
  })
  // The chip names the file and its size; the picture is not a chip.
  await expect(page.getByText('notes.txt')).toBeVisible()
  await expect(page.getByText('shot.png')).toBeHidden()

  // Sent from the keyboard, without leaving the text.
  await editor.click()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByText('Sending in 10 s')).toBeVisible()
  await expect(page.getByText('Sending in 10 s')).toBeHidden({ timeout: 20_000 })

  await expect.poll(() => bodyStructureFor(subject), { timeout: 30_000 }).not.toBeNull()
  const structure = JSON.stringify(await bodyStructureFor(subject))
  expect(structure).toContain('"multipart/related"')
  expect(structure).toMatch(
    /"type":"image\/png"[^}]*"cid":"[^"]+@mel"|"cid":"[^"]+@mel"[^}]*"type":"image\/png"/,
  )

  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await login(bobPage, ...BOB)
  await expect(bobPage.getByText(subject)).toBeVisible({ timeout: 30_000 })
  await bobPage.getByText(subject).click()
  const frame = bobPage.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('Look at this:')).toBeVisible()
  const shown = frame.locator('img')
  await expect
    .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 })
    .toBe(120)
  await expect(bobPage.getByRole('button', { name: /notes\.txt/ })).toBeVisible()
  await expect(bobPage.getByRole('button', { name: /shot\.png/ })).toBeHidden()

  // Forwarding passes both on: the picture inside the quote, the file as a file.
  await bobPage.getByRole('button', { name: 'Forward', exact: true }).click()
  const quoted = bobPage.locator('.ProseMirror blockquote img.compose-inline-image')
  await expect
    .poll(() => quoted.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 15_000 })
    .toBe(120)
  await expect(bobPage.getByRole('dialog').getByText('notes.txt')).toBeVisible()
  await bobCtx.close()
})

/** Drops files on an element the way a file manager would. */
async function dropFiles(
  page: Page,
  selector: string,
  files: Array<{ name: string; type: string; base64: string }>,
) {
  await page
    .locator(selector)
    .first()
    .evaluate((target, list) => {
      const data = new DataTransfer()
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
        data.items.add(new File([bytes], f.name, { type: f.type }))
      }
      const rect = target.getBoundingClientRect()
      const at = { clientX: rect.left + 10, clientY: rect.top + 10 }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...at }),
        )
      }
    }, files)
}

test('a picture dropped into the text goes inline, a file dropped on the window is attached', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'drag and drop is a pointer gesture')
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New message' }).click()
  const png = (await picture(page)).toString('base64')

  await dropFiles(page, '.ProseMirror', [{ name: 'drop.png', type: 'image/png', base64: png }])
  await expect(page.locator('.ProseMirror img.compose-inline-image')).toHaveCount(1)
  // Once: the window's own drop handler must not attach it a second time.
  await expect(page.getByRole('dialog').getByText('drop.png')).toBeHidden()

  await dropFiles(page, 'input[placeholder="Subject"]', [
    { name: 'plan.txt', type: 'text/plain', base64: Buffer.from('x').toString('base64') },
  ])
  await expect(page.getByRole('dialog').getByText('plan.txt')).toHaveCount(1)

  // Leave nothing behind in Drafts.
  await expect(page.getByText('Draft saved')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Delete draft' }).click()
})

/*
 * Issue #49: the Reply buttons are live while the reading pane is still
 * fetching the body, and the composer used to quote whatever it had — which,
 * in that window, was nothing. Delaying the body fetch makes the window wide
 * enough to click in reliably; the quote has to turn up afterwards.
 */
test('a reply opened before the body arrives still gets its quote', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.route('http://localhost:8080/jmap/**', async (route) => {
    const body = route.request().postData() ?? ''
    // Only the body fetch: the header set the list is built from has no
    // bodyValues, so this leaves the rest of the app at full speed.
    if (body.includes('bodyValues')) await new Promise((r) => setTimeout(r, 4000))
    return route.continue()
  })

  await page.getByTestId('thread-subject').filter({ hasText: 'Willkommen bei mel' }).first().click()
  // Straight into the reply, without waiting for the pane to finish loading.
  await page.getByRole('button', { name: 'Reply', exact: true }).click()

  const editor = page.locator('.ProseMirror')
  await expect(editor).toBeVisible({ timeout: 10_000 })
  // Typing first, because the quote must land underneath what is being
  // written rather than on top of the cursor.
  await editor.click()
  await page.keyboard.type('meine antwort')

  await expect(editor.locator('blockquote')).toContainText('erste Testmail', { timeout: 20_000 })
  await expect(editor).toContainText('meine antwort')
})

test('Cc and Bcc reveal a recipient field each, independently', async ({ page }) => {
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New message' }).click()

  await expect(page.getByPlaceholder('Cc', { exact: true })).toBeHidden()
  await expect(page.getByPlaceholder('Bcc', { exact: true })).toBeHidden()

  await page.getByRole('button', { name: 'Cc', exact: true }).click()
  await expect(page.getByPlaceholder('Cc', { exact: true })).toBeVisible()
  // Revealing Cc must not also reveal Bcc, and vice versa below.
  await expect(page.getByPlaceholder('Bcc', { exact: true })).toBeHidden()

  await page.getByRole('button', { name: 'Bcc', exact: true }).click()
  await expect(page.getByPlaceholder('Bcc', { exact: true })).toBeVisible()

  await page.getByPlaceholder('Cc', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Bcc', { exact: true }).fill('bob@localhost')
})

test('a mailto: link and a share both open the composer filled in', async ({ page }) => {
  /*
   * The two ways the rest of the system reaches into mel once it is installed
   * (manifest protocol_handlers and share_target, see vite.config.ts). Both
   * land on /compose, which is not a screen — it opens the composer and
   * replaces itself with /mail, so the handover never sits in the history.
   */
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  const mailto =
    'mailto:erika+news@example.com?cc=bob@localhost&subject=Rechnung März&body=Hallo\nGruss'
  await page.goto(`/compose?mailto=${encodeURIComponent(mailto)}`)

  await expect(page).toHaveURL(/\/mail$/, { timeout: 15_000 })
  // The plus is part of the address, not a space: a mailto query is
  // percent-encoded, never form-encoded.
  await expect(page.getByPlaceholder('To', { exact: true })).toHaveValue('erika+news@example.com')
  await expect(page.getByPlaceholder('Cc', { exact: true })).toHaveValue('bob@localhost')
  await expect(page.getByPlaceholder('Subject', { exact: true })).toHaveValue('Rechnung März')

  await page.goBack()
  await expect(page).not.toHaveURL(/compose/)

  // A share arrives as separate title, text and link.
  await page.goto('/compose?subject=Look+at+this&body=some+text&url=https%3A%2F%2Fexample.com')

  await expect(page).toHaveURL(/\/mail$/, { timeout: 15_000 })
  await expect(page.getByPlaceholder('Subject', { exact: true })).toHaveValue('Look at this')
  await expect(page.getByText('https://example.com')).toBeVisible()
})
