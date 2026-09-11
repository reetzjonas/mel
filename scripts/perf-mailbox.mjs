/*
 * Reproduces the "opening a folder is slow on a large account" class of
 * problem (#46, #47) without needing a large account: log in against the
 * seeded Stalwart, then inject synthetic rows straight into IndexedDB and time
 * folder opens offline, so nothing measured here is network.
 *
 * Usage: node scripts/perf-mailbox.mjs [messageCount]
 */
import { chromium } from 'playwright'

const COUNT = Number(process.argv[2] ?? 36_000)
const BASE = process.env.MEL_BASE_URL ?? 'http://localhost:5173'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

await page.goto(`${BASE}/mail`)
await page.getByPlaceholder('you@example.com').fill('alice@localhost')
await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
await page.getByRole('button', { name: 'Connect' }).click()
await page.getByTestId('sync-status').waitFor({ timeout: 30_000 })
await page.getByRole('link', { name: /^Inbox/ }).waitFor({ timeout: 30_000 })

const mailboxes = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open('mel')
      req.onsuccess = () => {
        const tx = req.result.transaction(['mailboxes', 'accounts'], 'readonly')
        const boxes = tx.objectStore('mailboxes').getAll()
        const accounts = tx.objectStore('accounts').getAll()
        tx.oncomplete = () => {
          const accountId = accounts.result[0].id
          resolve({
            accountId,
            boxes: boxes.result.map((b) => ({ id: b.id, role: b.payload?.plain?.role ?? null })),
          })
        }
      }
    }),
)

/*
 * Cut off the mail server, not the whole browser: a sync would notice the
 * synthetic ids are not on the server and delete them again, but the app
 * itself still has to load from the dev server. `setOffline` would block both.
 */
await page.route('http://localhost:8080/**', (r) => r.abort('failed'))

const injected = await page.evaluate(
  async ({ accountId, boxes, count }) => {
    const inbox = boxes.find((b) => b.role === 'inbox') ?? boxes[0]
    const archive = boxes.find((b) => b.role === 'archive') ?? inbox
    const sent = boxes.find((b) => b.role === 'sent') ?? inbox
    const started = performance.now()
    const db = await new Promise((resolve) => {
      const r = indexedDB.open('mel')
      r.onsuccess = () => resolve(r.result)
    })
    const CHUNK = 2000
    for (let from = 0; from < count; from += CHUNK) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('emails', 'readwrite')
        const store = tx.objectStore('emails')
        for (let i = from; i < Math.min(from + CHUNK, count); i++) {
          // Every fourth message answers the one before it, so the account has
          // real multi-message threads rather than 36k threads of one.
          const threadId = `perf-t${Math.floor(i / 4)}`
          // Spread across three folders; the inbox keeps the lion's share.
          const box = i % 7 === 0 ? archive.id : i % 11 === 0 ? sent.id : inbox.id
          const receivedAt = Date.UTC(2020, 0, 1) + i * 60_000
          store.put({
            accountId,
            id: `perf-${i}`,
            threadId,
            mailboxIds: [box],
            // Mirrors mailboxDateKey() in src/storage/emailRow.ts. Duplicated
            // rather than imported because this runs as a plain script against
            // the built app; if the format there changes, change it here.
            mailboxDates: [
              `${box}\u0000${String(9999999999999 - receivedAt).padStart(13, '0')}\u0000${threadId}`,
            ],
            receivedAt,
            unread: i % 9 === 0 ? 1 : 0,
            flagged: i % 23 === 0 ? 1 : 0,
            payload: {
              plain: {
                id: `perf-${i}`,
                threadId,
                mailboxIds: { [box]: true },
                keywords: i % 9 === 0 ? {} : { $seen: true },
                from: [{ name: `Sender ${i % 500}`, email: `s${i % 500}@example.com` }],
                to: [{ name: null, email: 'alice@localhost' }],
                cc: [],
                subject: `Synthetic message ${i}`,
                receivedAt: new Date(receivedAt).toISOString(),
                sentAt: null,
                preview: 'Injected by scripts/perf-mailbox.mjs for timing runs.',
                hasAttachment: false,
                size: 2048,
                messageId: [`<perf-${i}@example.com>`],
                references: null,
              },
            },
          })
        }
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    }
    db.close()
    return { ms: Math.round(performance.now() - started), inbox: inbox.id, archive: archive.id }
  },
  { accountId: mailboxes.accountId, boxes: mailboxes.boxes, count: COUNT },
)
console.log(`injected ${COUNT} rows in ${injected.ms}ms`)

/** Click a folder and wait until its first row is on screen. */
async function openFolder(name) {
  const started = Date.now()
  await page.getByRole('link', { name }).first().click()
  await page.getByTestId('thread-subject').first().waitFor({ timeout: 60_000 })
  return Date.now() - started
}

for (const grouped of [true, false]) {
  await page.goto(`${BASE}/mail`)
  if (!grouped) {
    // Turn conversations off through the UI so the ungrouped path is measured.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Mail' }).click()
    await page.getByLabel('Conversations').selectOption('off')
    await page.getByRole('button', { name: 'Close settings' }).click()
  }
  await page.reload()
  const label = grouped ? 'grouped  ' : 'ungrouped'
  const first = await openFolder(/^Inbox/)
  const second = await openFolder(/^Archive/)
  const third = await openFolder(/^Inbox/)
  console.log(
    `${label}  first open ${first}ms   then Archive ${second}ms   back to Inbox ${third}ms`,
  )
}

await browser.close()
