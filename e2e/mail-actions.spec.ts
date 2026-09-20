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

test('sender image permissions persist, stay scoped, and can be revoked in settings', async ({
  page,
}) => {
  test.setTimeout(60_000)
  // Keep the seeded messages intact on the server, but give their fetched
  // bodies remote content so this exercises the real reading pane and CSP.
  await page.route('**/jmap/**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const json = await response.json()
    for (const [method, data] of json.methodResponses ?? []) {
      if (method !== 'Email/get') continue
      for (const email of data.list ?? []) {
        if (!email.bodyValues) continue
        email.htmlBody = [{ partId: 'probe', type: 'text/html' }]
        email.bodyValues = {
          probe: {
            value: '<p>Image permission test</p><img src="https://tracker.invalid/pixel.png">',
            isTruncated: false,
          },
        }
      }
    }
    await route.fulfill({ response, json })
  })
  let hits = 0
  await page.route('https://tracker.invalid/**', async (route) => {
    hits++
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    })
  })
  await login(page, ...ALICE)
  const open = async (subject: string) => {
    await page
      .getByRole('button', { name: new RegExp(subject) })
      .first()
      .click()
    await expect(
      page.frameLocator('iframe[title="Message content"]').getByText('Image permission test'),
    ).toBeVisible()
  }
  const always = page.getByRole('button', {
    name: 'Always load images from this sender',
    exact: true,
  })
  const load = page.getByRole('button', { name: 'Load images', exact: true })
  await open('HTML-Test')
  await expect(always).toBeVisible()
  expect(hits).toBe(0)
  await always.click()
  await expect.poll(() => hits).toBeGreaterThan(0)
  await expect(load).toBeHidden()
  const image = page.frameLocator('iframe[title="Message content"]').locator('img')
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  const beforeReload = hits
  /*
   * On reload the body is cached, while the sender permission still has to
   * arrive. Make that ordering deterministic instead of relying on disk speed,
   * and record every policy the frame is ever given: the message must be
   * rendered once, already allowed. Handing it a blocked document first and
   * replacing it when the permission lands is a second navigation of the same
   * frame, and which of the two documents survives is up to the engine.
   */
  await page.addInitScript(() => {
    const policies: string[] = []
    ;(window as unknown as { melFramePolicies: string[] }).melFramePolicies = policies
    new MutationObserver(() => {
      for (const frame of document.querySelectorAll('iframe[title="Message content"]')) {
        const policy = frame.getAttribute('srcdoc')?.match(/img-src [^;]*/)?.[0]
        if (policy && policies.at(-1) !== policy) policies.push(policy)
      }
      // `document`, not `documentElement`: an init script runs before the
      // document has an element to hang an observer on.
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['srcdoc'],
    })
    const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!
    Object.defineProperty(IDBRequest.prototype, 'onsuccess', {
      ...descriptor,
      set(handler) {
        if (
          this.source instanceof IDBObjectStore &&
          this.source.name === 'imageSenders' &&
          this.source.transaction.mode === 'readonly' &&
          handler
        ) {
          descriptor.set!.call(this, function (this: IDBRequest, event: Event) {
            setTimeout(() => handler.call(this, event), 300)
          })
        } else descriptor.set!.call(this, handler)
      },
    })
  })
  await page.reload()
  await expect(
    page.frameLocator('iframe[title="Message content"]').getByText('Image permission test'),
  ).toBeVisible()
  await expect(load).toBeHidden()
  await expect.poll(() => hits).toBeGreaterThan(beforeReload)
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  expect(
    await page.evaluate(
      () => (window as unknown as { melFramePolicies: string[] }).melFramePolicies,
    ),
  ).toEqual(['img-src http: https: data: cid:'])

  // An allowed sender still cannot load images in Junk. Only the one-time
  // action is available there; moving it back restores the sender permission.
  await moveToJunk('HTML-Test')
  await page.reload()
  await page.getByRole('link', { name: /^Junk Mail( \d+)?$/ }).click()
  const beforeJunk = hits
  await open('HTML-Test')
  await expect(load).toBeVisible()
  await expect(always).toBeHidden()
  expect(hits).toBe(beforeJunk)
  await load.click()
  await expect.poll(() => hits).toBeGreaterThan(beforeJunk)
  await page.getByRole('article').getByRole('button', { name: 'Not spam', exact: true }).click()
  await page.getByRole('link', { name: /^Inbox( \d+)?$/ }).click()

  // Another message from Bob inherits the permission; the newsletter does not.
  await open('Willkommen bei mel')
  await expect(load).toBeHidden()
  await open('Newsletter-Test')
  await expect(load).toBeVisible()
  await load.click()
  await expect(load).toBeHidden()
  await open('HTML-Test')
  await open('Newsletter-Test')
  await expect(load).toBeVisible()

  await open('HTML-Test')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('tab', { name: 'Mail', exact: true }).click()
  await settings
    .getByRole('button', { name: 'Remove permission for bob@localhost', exact: true })
    .click()
  await expect(settings.getByText('No senders allowed yet.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(load).toBeVisible()
  await page.reload()
  await expect(load).toBeVisible()
})

test('archive a mail and undo it', async ({ page }) => {
  await login(page, ...ALICE)
  const firstRow = page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first()
  await expect(firstRow).toBeVisible({ timeout: 15_000 })
  // Whatever mail is on top — independent of previous runs' server state.
  // Reads a stable testid rather than indexing into the row's DOM structure.
  const subject = (await firstRow.getByTestId('thread-subject').innerText()).trim()

  await firstRow.click()
  await page.getByRole('article').getByRole('button', { name: 'Archive', exact: true }).click()

  // The first archive on a fresh server also has to create the Archive mailbox,
  // which Stalwart does not provision — more than the default 5s allows for on
  // a CI runner.
  await expect(page.getByText('Archived')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(subject).first()).toBeHidden()

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText(subject).first()).toBeVisible({ timeout: 10_000 })
  // Let the undo reach the server before the context is torn down.
  await page.waitForTimeout(1500)
})

test('compose, send, and receive on the other account', async ({ page, browser }) => {
  test.setTimeout(90_000)
  const subject = `e2e-${Date.now()}`

  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'New message' }).click()
  await page.getByPlaceholder('To', { exact: true }).fill('bob@localhost')
  await page.getByPlaceholder('Subject', { exact: true }).fill(subject)
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('Hello Bob from the e2e test.')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sending in 10 s')).toBeVisible()

  // Sending starts when the undo snackbar goes away; delivery is covered by
  // the recipient's subject assertion below.
  await expect(page.getByText('Sending in 10 s')).toBeHidden({ timeout: 20_000 })

  const bobCtx = await browser.newContext()
  const bobPage = await bobCtx.newPage()
  await login(bobPage, ...BOB)
  await expect(bobPage.getByText(subject)).toBeVisible({ timeout: 30_000 })
  await bobPage.getByText(subject).click()
  const frame = bobPage.frameLocator('iframe[title="Message content"]')
  await expect(frame.getByText('Hello Bob from the e2e test.')).toBeVisible()
  await bobCtx.close()
})

test('filter the folder to flagged only, in the URL and across a reload', async ({ page }) => {
  await login(page, ...ALICE)
  const rowFor = (subject: string) =>
    page.locator('[data-testid="virtuoso-item-list"] [role="button"]', { hasText: subject }).first()

  const target = rowFor('HTML-Test')
  await expect(target).toBeVisible({ timeout: 15_000 })

  // Idempotent: a previous failed run may have left the flag set, and the
  // shared account carries that over.
  await target.hover()
  const flag = target.getByRole('button', { name: 'Flag', exact: true })
  if (await flag.isVisible()) await flag.click()
  await target.hover()
  await expect(target.getByRole('button', { name: 'Remove flag' })).toBeVisible()

  const flaggedOnly = page.getByRole('button', { name: 'Flagged only' })
  await flaggedOnly.click()

  // The filter is URL state, not component state: it has to survive a reload
  // and stay shareable, and the folder context stays visible throughout.
  await expect(page).toHaveURL(/[?&]filter=flagged/)
  await expect(flaggedOnly).toHaveAttribute('aria-pressed', 'true')
  await expect(rowFor('HTML-Test')).toBeVisible()
  await expect(page.getByText('Willkommen bei mel')).toBeHidden()

  await page.reload()
  await expect(flaggedOnly).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(rowFor('HTML-Test')).toBeVisible()
  await expect(page.getByText('Willkommen bei mel')).toBeHidden()

  // Clearing the flag has to drop the row from a flagged-only list the same way
  // moving it to another folder would — this is also the cleanup.
  await rowFor('HTML-Test').hover()
  await rowFor('HTML-Test').getByRole('button', { name: 'Remove flag' }).click()
  await expect(page.getByText('HTML-Test')).toBeHidden({ timeout: 10_000 })

  // Toggling the filter off restores the whole folder and the clean URL.
  await flaggedOnly.click()
  await expect(page).not.toHaveURL(/filter=/)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible()
  await expect(page.getByText('HTML-Test')).toBeVisible()
})

test('opening a message keeps the active filter in the URL', async ({ page }) => {
  await login(page, ...ALICE)
  const rowFor = (subject: string) =>
    page.locator('[data-testid="virtuoso-item-list"] [role="button"]', { hasText: subject }).first()

  const target = rowFor('HTML-Test')
  await expect(target).toBeVisible({ timeout: 15_000 })
  await target.hover()
  const flag = target.getByRole('button', { name: 'Flag', exact: true })
  if (await flag.isVisible()) await flag.click()
  await target.hover()
  await expect(target.getByRole('button', { name: 'Remove flag' })).toBeVisible()

  await page.getByRole('button', { name: 'Flagged only' }).click()
  await expect(page).toHaveURL(/[?&]filter=flagged/)

  // Clicking through to the message must not drop the filter from the URL —
  // it would otherwise vanish the moment the route changes, and the back
  // button would land on the unfiltered list.
  await rowFor('HTML-Test').click()
  await expect(page).toHaveURL(/[?&]filter=flagged/)
  await expect(page).toHaveURL(/\/mail\/[^/]+\/[^/?]+\?/)

  // Cleanup: unflag and clear the filter for the next run.
  await page.getByRole('article').getByRole('button', { name: 'Remove flag' }).click()
  await page.getByRole('button', { name: 'Flagged only' }).click()
  await expect(page).not.toHaveURL(/filter=/)
})

test('quick actions on list rows: flag and mark unread without opening', async ({ page }) => {
  await login(page, ...ALICE)
  const row = page
    .locator('[data-testid="virtuoso-item-list"] [role="button"]', { hasText: 'HTML-Test' })
    .first()
  await expect(row).toBeVisible({ timeout: 15_000 })

  await row.hover()
  await row.getByRole('button', { name: 'Flag', exact: true }).click()
  await row.hover()
  await expect(row.getByRole('button', { name: 'Remove flag' })).toBeVisible()
  await row.getByRole('button', { name: 'Remove flag' }).click()
  await row.hover()
  await expect(row.getByRole('button', { name: 'Flag', exact: true })).toBeVisible()

  // Mark read/unread toggle from the list.
  await row.hover()
  const markUnread = row.getByRole('button', { name: 'Mark unread' })
  const markRead = row.getByRole('button', { name: 'Mark read' })
  if (await markUnread.isVisible()) {
    await markUnread.click()
    await row.hover()
    await expect(markRead).toBeVisible()
  } else {
    await markRead.click()
    await row.hover()
    await expect(markUnread).toBeVisible()
  }
})

test('search filters by subject server-side', async ({ page }) => {
  await login(page, ...ALICE)
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })

  await page.getByPlaceholder(/Search/).fill('subject:Projektstand')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Kurzes Update')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Willkommen bei mel')).toBeHidden()
})

/*
 * Dragging a row onto a folder. The menu and the selection toolbar keep doing
 * the same job for keyboard and touch, which have no drag — this only adds the
 * pointer path, so it has to move exactly what the row's other actions would.
 */
test('dragging a row onto a folder moves it, and undo brings it back', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page, ...ALICE)
  const rows = page.getByTestId('thread-subject')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  const subject = (await rows.first().innerText()).trim()
  const row = page.getByTestId('thread-subject').filter({ hasText: subject }).first()
  await row.dragTo(page.getByRole('link', { name: /^Archive/ }))

  await expect(page.getByText('Moved')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('thread-subject').filter({ hasText: subject })).toHaveCount(0)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByTestId('thread-subject').filter({ hasText: subject })).toHaveCount(1, {
    timeout: 15_000,
  })
  // Let the undo reach the server before teardown.
  await page.waitForTimeout(1500)
})

test('bulk select two messages, archive them, and undo', async ({ page }) => {
  test.setTimeout(60_000)
  await login(page, ...ALICE)
  const rows = page.locator('[data-testid="virtuoso-item-list"] [role="button"]')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  const subjects: string[] = []
  for (const i of [0, 1]) {
    const row = rows.nth(i)
    subjects.push((await row.getByTestId('thread-subject').innerText()).trim())
    // The avatar turns into a checkbox on hover — no extra column.
    await row.hover()
    await row.getByRole('checkbox').click()
  }

  const toolbar = page.getByTestId('selection-toolbar')
  await expect(toolbar).toContainText('2 selected')
  await page.setViewportSize({ width: 320, height: 720 })
  expect(await toolbar.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await toolbar.evaluate((element) => element.clientWidth),
  )
  await toolbar.getByRole('button', { name: 'More selection actions' }).click()
  const moreActions = toolbar.getByRole('menu', { name: 'More selection actions' })
  await expect(moreActions.getByRole('menuitem', { name: 'Mark read' })).toBeVisible()
  await expect(moreActions.getByRole('menuitem', { name: 'Mark unread' })).toBeVisible()
  await expect(moreActions.getByRole('menuitem', { name: 'Flag' })).toBeVisible()
  await page.keyboard.press('Escape')

  await toolbar.getByLabel('Archive').click()
  // The first archive on a fresh server also has to create the Archive mailbox,
  // which Stalwart does not provision — more than the default 5s allows for on
  // a CI runner.
  await expect(page.getByText('Archived')).toBeVisible({ timeout: 20_000 })
  for (const s of subjects) await expect(page.getByText(s).first()).toBeHidden()

  await page.getByRole('button', { name: 'Undo' }).click()
  for (const s of subjects) {
    await expect(page.getByText(s).first()).toBeVisible({ timeout: 10_000 })
  }
  // Let the undo reach the server before teardown.
  await page.waitForTimeout(1500)
})

test('shift-clicking a second row takes the whole run between them', async ({ page }) => {
  await login(page, ...ALICE)
  const rows = page.locator('[data-testid="virtuoso-item-list"] [role="button"]')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })
  // Needs three rows to prove the middle one is taken along rather than just
  // the two that were clicked.
  expect(await rows.count()).toBeGreaterThanOrEqual(3)

  await rows.nth(0).hover()
  await rows.nth(0).getByRole('checkbox').click()
  await rows.nth(2).hover()
  await rows
    .nth(2)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] })

  // The row in the middle is the claim: it was never clicked, so it is only
  // ticked if the range was taken. Counting messages instead would prove
  // nothing — a conversation row carries several on its own.
  await expect(rows.nth(1)).toHaveAttribute('data-checked', 'true')
  await expect(page.getByTestId('selection-toolbar')).toContainText('selected')
  const toolbar = page.getByTestId('selection-toolbar')

  await toolbar.getByLabel('Move to folder').click()
  const picker = page.getByTestId('move-folder-picker')
  await expect(picker).toBeVisible()
  await page.mouse.click(0, 0)
  await expect(picker).toHaveCount(0)

  await toolbar.getByLabel('Clear selection').click()
  await expect(toolbar).toBeHidden()
})

test('select-all in the folder is offered from the first tick, server-side', async ({ page }) => {
  await login(page, ...ALICE)
  const rows = page.locator('[data-testid="virtuoso-item-list"] [role="button"]')
  await expect(rows.first()).toBeVisible({ timeout: 15_000 })

  // One row is enough — nobody should have to tick hundreds by hand first.
  await rows.first().hover()
  await rows.first().getByRole('checkbox').click()

  const toolbar = page.getByTestId('selection-toolbar')
  await expect(toolbar).toContainText('1 selected')

  const selectAll = toolbar.getByRole('button', { name: 'Select everything in this folder' })
  await expect(selectAll).toBeVisible()
  await selectAll.click()

  // Ids come from the server, not the local cache, so every seeded mail counts.
  const loaded = await rows.count()
  await expect(toolbar).toContainText(`${loaded} selected`)

  await toolbar.getByLabel('Clear selection').click()
  await expect(toolbar).toBeHidden()
})

test('hovering a row leaves the sender avatar alone', async ({ page }) => {
  await login(page, ...ALICE)
  const row = page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first()
  await expect(row).toBeVisible({ timeout: 15_000 })

  const avatar = row.locator('span > span').first()
  const checkbox = row.getByRole('checkbox')
  const settle = () => page.waitForTimeout(400)

  // Hover the tile far from the avatar: the sender icon must stay put. It used
  // to be swapped for the checkbox by a row-wide group-hover, which read as the
  // avatar vanishing whenever the pointer entered the row.
  const box = (await row.boundingBox())!
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2)
  await settle()
  await expect(avatar).toBeVisible()
  await expect(checkbox).toHaveCSS('opacity', '0')

  // Only over the avatar itself does the selection affordance show up.
  await checkbox.hover()
  await settle()
  await expect(checkbox).toHaveCSS('opacity', '1')
  await expect(avatar).toBeVisible()
})

test('opening a message offers a link to the sender’s contact, only once one exists', async ({
  page,
}) => {
  const surname = `Sender${Date.now() % 100000}`

  await login(page, ...ALICE)

  // "HTML-Test" is a seeded message from bob@localhost. Checked before and
  // after the card exists in the same session, so this never depends on a
  // contact deleted by an earlier run having actually reached the server yet.
  const openMessage = () =>
    page
      .locator('[data-testid="virtuoso-item-list"] [role="button"]', { hasText: 'HTML-Test' })
      .first()
      .click()

  await openMessage()
  await expect(page.getByRole('article')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View contact' })).toHaveCount(0)

  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page.getByRole('button', { name: 'New contact' }).click()
  await page.getByLabel('First name').fill('Bob')
  await page.getByLabel('Last name').fill(surname)
  await page.locator('input[type="email"]').first().fill('bob@localhost')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: `Bob ${surname}` })).toBeVisible()

  await page.getByRole('link', { name: 'Mail' }).first().click()
  await openMessage()
  await page.getByRole('link', { name: 'View contact' }).click()
  await expect(page).toHaveURL(/\/contacts\//)
  await expect(page.getByRole('heading', { name: `Bob ${surname}` })).toBeVisible()

  // Clean up, and check the link goes away again with it — the live query
  // behind it has to notice a contact leaving as readily as one arriving.
  await page.getByRole('button', { name: 'Delete contact' }).click()
  await page
    .getByRole('dialog', { name: 'Delete contact' })
    .getByRole('button', { name: 'Delete contact' })
    .click()
  await page.getByRole('link', { name: 'Mail' }).first().click()
  await openMessage()
  await expect(page.getByRole('link', { name: 'View contact' })).toHaveCount(0)
})

/** Files an inbox message into Junk over JMAP, returning its id. */
async function moveToJunk(subject: string): Promise<string> {
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
    .methodResponses[0]![1] as unknown as { list: Array<{ id: string; role: string | null }> }
  const junk = boxes.list.find((b) => b.role === 'junk')!
  const inbox = boxes.list.find((b) => b.role === 'inbox')!
  const q = (
    await call([
      [
        'Email/query',
        {
          accountId: 'c',
          filter: { inMailbox: inbox.id, subject },
          limit: 1,
        },
        'c0',
      ],
    ])
  ).methodResponses[0]![1] as unknown as { ids: string[] }
  const id = q.ids[0]!
  await call([
    ['Email/set', { accountId: 'c', update: { [id]: { mailboxIds: { [junk.id]: true } } } }, 'c0'],
  ])
  return id
}

test('junk blocks remote content regardless of the setting, and "not spam" restores it', async ({
  page,
}) => {
  test.setTimeout(60_000)
  // Do not move whichever seeded message happens to be first: other mail
  // checks name their fixture by subject and this test restores it only later.
  await moveToJunk('HTML-Test')

  await login(page, ...ALICE)
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({
    timeout: 15_000,
  })

  // Even with the account set to always load — a message the server already
  // flagged is the last one that should get a confirmed address.
  await page.evaluate(() => localStorage.setItem('mel:images', 'always'))
  await page.reload()

  await page.getByRole('link', { name: /^Junk Mail( \d+)?$/ }).click()
  const row = page.locator('[data-testid="virtuoso-item-list"] [role="button"]', {
    hasText: 'HTML-Test',
  })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()

  await expect
    .poll(() =>
      page.evaluate(() => {
        const f = document.querySelector('iframe') as HTMLIFrameElement | null
        return f?.srcdoc.match(/img-src ([^;"]*)/)?.[1]?.trim()
      }),
    )
    .toBe('data: cid:')

  // Reachable three ways: reading pane, row hover, and the bulk toolbar.
  // Scoped, because all three are on screen at once and share the label.
  await expect(page.getByRole('article').getByRole('button', { name: 'Not spam' })).toBeVisible()
  await page.getByRole('link', { name: /^Junk Mail( \d+)?$/ }).click()
  await row.hover()
  await expect(row.getByRole('button', { name: 'Not spam' })).toBeVisible()
  await row.getByRole('checkbox').click()
  const toolbar = page.getByTestId('selection-toolbar')
  await toolbar.getByRole('button', { name: 'More selection actions' }).click()
  const moreActions = toolbar.getByRole('menu', { name: 'More selection actions' })
  await expect(moreActions.getByRole('menuitem', { name: 'Not spam' })).toBeVisible()

  await moreActions.getByRole('menuitem', { name: 'Not spam' }).click()
  await expect(page.getByText('Moved to inbox')).toBeVisible()

  // Back where it started, so the run leaves nothing behind.
  await page.getByRole('link', { name: /^Inbox( \d+)?$/ }).click()
  await expect(row).toBeVisible({ timeout: 15_000 })
  // Nothing to un-junk here, so the shortcut must not clutter the row.
  await row.hover()
  await expect(row.getByRole('button', { name: 'Not spam' })).toHaveCount(0)
  await page.waitForTimeout(2000)
  await page.evaluate(() => localStorage.removeItem('mel:images'))
})
