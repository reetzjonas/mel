#!/usr/bin/env node
/**
 * Regenerates docs/media/screenshot-<view>-{light,dark}.png for the README.
 *
 * One pair per app — mail, calendar, contacts, files — because a README that
 * claims four apps and shows one is a README that shows one.
 *
 * Requires a running dev server and a seeded Stalwart:
 *   npm run stalwart:up && npm run stalwart:seed && npm run dev
 * Then, in another terminal:
 *   node scripts/screenshot-readme.mjs [--base-url http://localhost:5173]
 *
 * What it does: sends a handful of realistic demo messages into alice's
 * inbox over SMTP (same trick as docker/stalwart/seed.sh — plain SMTP
 * against the dev Stalwart, no auth needed on that port), logs into the
 * app in a real browser once per color scheme, opens one of them, and
 * screenshots the result. It also creates demo events, contacts and files
 * over JMAP, since `seed.sh` provisions mail and nothing else.
 *
 * Everything it creates is destroyed again at the end (in a `finally`, so a
 * crash mid-run doesn't leave it behind) — this script must not alter what
 * `npm run stalwart:seed` / e2e's global-setup expect to find on the
 * account.
 *
 * Gotcha, hard-won — do not try to "simplify" this back to a plain
 * `page.screenshot()`: the message body renders in a sandboxed `srcDoc`
 * iframe (ReadingPane.tsx — deliberately no `allow-same-origin`, mail
 * scripts must never reach the app's origin). Chromium puts that iframe
 * in its own compositing surface, and a full-page `page.screenshot()`
 * sometimes paints it blank/white in the output even though the iframe's
 * own DOM and CSS are correct (verified independently: reading `srcdoc`
 * back, and screenshotting the iframe element on its own both showed the
 * right colors). `--disable-features=IsolateSandboxedIframes,site-per-process`
 * on the browser launch did not fix it. The workaround below captures the
 * page and the iframe element as two separate screenshots and composites
 * them with a `<canvas>` in a throwaway page — no native image library
 * needed, just the browser's own Canvas API.
 */

import { chromium } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'docs', 'media')

const baseUrlFlagIndex = process.argv.indexOf('--base-url')
const BASE_URL =
  baseUrlFlagIndex !== -1
    ? process.argv[baseUrlFlagIndex + 1]
    : (process.env.MEL_SCREENSHOT_BASE_URL ?? 'http://localhost:5173')

const EMAIL = 'alice@localhost'
const PASSWORD = 'korrekt-pferd-batterie-alice'
const VIEWPORT = { width: 1440, height: 900 }

// A believable little conversation — plain text, no markup, so it also
// doubles as a check that plain-text mail follows the app's theme (the
// original bug this script was written to catch: Stalwart mirrors a
// plain-text part into `htmlBody` per RFC 8621 §4.1.4, and mel used to
// treat that as real HTML and render it on a fixed white background —
// see toEmailBody() / htmlPartText() in src/providers/jmap/mappers/mail.ts).
const DEMO_MAIL = [
  {
    from: 'Elena Vogt <elena.vogt@example.com>',
    subject: 'Coffee next week?',
    body: 'Hey! Are you around Tuesday afternoon? Would love to grab coffee and catch up.',
  },
  {
    from: 'Notifications <notifications@example.com>',
    subject: 'Weekly digest: 3 new comments',
    body: "You have new activity on your recent changes. Open the app to see what's new.",
  },
  {
    from: 'Tom Walsh <tom.walsh@example.com>',
    subject: 'Re: Calendar sync issue',
    body: 'Fixed! Turned out to be a timezone edge case around DST. Thanks for flagging it.',
  },
  {
    from: 'Priya Nair <priya.nair@example.com>',
    subject: 'Design review: new inbox layout',
    body: 'Hi Alice, Could you take a look at the updated conversation view before Thursday? I think grouping replies really helps. Thanks, Priya',
  },
]
// Which one is open in the reading pane for the screenshot.
const OPEN_SUBJECT = 'Design review: new inbox layout'

async function sendMail({ from, subject, body }) {
  const msg =
    `From: ${from}\r\nTo: ${EMAIL}\r\nSubject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@screenshot-readme>\r\n\r\n` +
    `${body}\r\n`
  // Piped through base64 so subject/body content can never break out of
  // the shell command (same SMTP relay trick as docker/stalwart/seed.sh).
  const b64 = Buffer.from(msg, 'utf8').toString('base64')
  await exec('sh', [
    '-c',
    `echo ${b64} | base64 -d | curl -sS "smtp://localhost:1025/seed.mel.dev" --mail-from bob@localhost --mail-rcpt ${EMAIL} -T -`,
  ])
}

async function jmapSession() {
  const res = await fetch('http://localhost:8080/.well-known/jmap', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64') },
  })
  const session = await res.json()
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']
  return { apiUrl: session.apiUrl, uploadUrl: session.uploadUrl, accountId }
}

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'
const CALENDARS = 'urn:ietf:params:jmap:calendars'
const CONTACTS = 'urn:ietf:params:jmap:contacts'
const FILENODE = 'urn:ietf:params:jmap:filenode'

async function jmapCall(apiUrl, methodCalls, using = [CORE, MAIL]) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ using, methodCalls }),
  })
  const body = await res.json()
  const failed = body.methodResponses?.find(([name]) => name === 'error')
  if (failed) throw new Error(`JMAP ${JSON.stringify(failed[1])}`)
  return body
}

/** Finds the ids of the messages this script just sent, by subject. */
async function findDemoIds(apiUrl, accountId) {
  const subjects = new Set(DEMO_MAIL.map((m) => m.subject))
  const data = await jmapCall(apiUrl, [
    [
      'Email/query',
      { accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 20 },
      'q',
    ],
    [
      'Email/get',
      {
        accountId,
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['subject'],
      },
      'g',
    ],
  ])
  const list = data.methodResponses[1][1].list
  return list.filter((e) => subjects.has(e.subject)).map((e) => e.id)
}

async function destroyIds(apiUrl, accountId, ids) {
  if (!ids.length) return
  await jmapCall(apiUrl, [['Email/set', { accountId, destroy: ids }, 'd']])
}

/*
 * Demo data for the other three apps.
 *
 * seed.sh provisions mail and nothing else, so a calendar, contacts and files
 * screenshot would otherwise be three pictures of an empty state. Each of
 * these returns the ids it created; main() destroys them in its `finally`.
 */

/** Monday of the week on screen, so the events land where the grid opens. */
function mondayOfThisWeek() {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  d.setHours(0, 0, 0, 0)
  return d
}

const DEMO_EVENTS = [
  { day: 0, at: '09:30', hours: 1, title: 'Standup' },
  { day: 0, at: '14:00', hours: 1.5, title: 'Design review' },
  { day: 1, at: '11:00', hours: 1, title: 'Coffee with Elena' },
  { day: 2, at: '09:00', hours: 2, title: 'Migration planning' },
  { day: 2, at: '16:00', hours: 1, title: '1:1 with Tom' },
  { day: 3, at: '10:00', hours: 3, title: 'Workshop: offline-first' },
  { day: 4, at: '13:00', hours: 1, title: 'Retro' },
]

async function createEvents(apiUrl, accountId) {
  const { methodResponses } = await jmapCall(
    apiUrl,
    [['Calendar/get', { accountId, ids: null }, 'c']],
    [CORE, CALENDARS],
  )
  const calendar =
    methodResponses[0][1].list.find((c) => c.isDefault) ?? methodResponses[0][1].list[0]
  if (!calendar) return []

  const monday = mondayOfThisWeek()
  const create = {}
  DEMO_EVENTS.forEach((e, i) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + e.day)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    create[`e${i}`] = {
      '@type': 'Event',
      calendarIds: { [calendar.id]: true },
      title: e.title,
      start: `${date}T${e.at}:00`,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      duration: `PT${Math.round(e.hours * 60)}M`,
    }
  })
  const res = await jmapCall(
    apiUrl,
    [['CalendarEvent/set', { accountId, create }, 's']],
    [CORE, CALENDARS],
  )
  return Object.values(res.methodResponses[0][1].created ?? {}).map((v) => v.id)
}

// Filled in rather than minimal: the card on the right is most of the
// screenshot, and a name with one address under it shows an empty pane.
const DEMO_CONTACTS = [
  {
    given: 'Elena',
    surname: 'Vogt',
    email: 'elena.vogt@example.com',
    org: 'Auburn Studio',
    title: 'Design lead',
    phone: '+49 30 6127 4408',
    address: 'Chausseestraße 12, 10115 Berlin',
    url: 'https://auburn.example.com/elena',
    note: 'Prefers a call over a thread. Back from parental leave in March.',
  },
  {
    given: 'Tom',
    surname: 'Walsh',
    email: 'tom.walsh@example.com',
    org: 'Northwind',
    title: 'Backend',
    phone: '+353 1 903 2214',
  },
  {
    given: 'Priya',
    surname: 'Nair',
    email: 'priya.nair@example.com',
    org: 'Auburn Studio',
    title: 'Product',
    phone: '+44 20 7946 0813',
  },
  {
    given: 'Jonas',
    surname: 'Berger',
    email: 'jonas.berger@example.com',
    org: 'Freelance',
    title: 'Illustration',
    phone: '+49 40 4711 2205',
  },
  {
    given: 'Amara',
    surname: 'Okafor',
    email: 'amara.okafor@example.com',
    org: 'Northwind',
    title: 'Infrastructure',
    phone: '+234 1 271 0094',
  },
  {
    given: 'Sven',
    surname: 'Lindqvist',
    email: 'sven.lindqvist@example.com',
    org: 'Kvist AB',
    title: 'Founder',
    phone: '+46 8 505 12 90',
  },
]

async function createContacts(apiUrl, accountId) {
  const { methodResponses } = await jmapCall(
    apiUrl,
    [['AddressBook/get', { accountId, ids: null }, 'b']],
    [CORE, CONTACTS],
  )
  const book = methodResponses[0][1].list.find((b) => b.isDefault) ?? methodResponses[0][1].list[0]
  if (!book) return []

  const create = {}
  DEMO_CONTACTS.forEach((c, i) => {
    create[`c${i}`] = {
      '@type': 'Card',
      version: '1.0',
      kind: 'individual',
      addressBookIds: { [book.id]: true },
      name: {
        components: [
          { kind: 'given', value: c.given },
          { kind: 'surname', value: c.surname },
        ],
        isOrdered: true,
      },
      organizations: { o0: { name: c.org } },
      titles: c.title ? { t0: { name: c.title } } : null,
      emails: { e0: { address: c.email } },
      phones: { p0: { number: c.phone } },
      addresses: c.address ? { a0: { full: c.address } } : null,
      links: c.url ? { l0: { uri: c.url } } : null,
      notes: c.note ? { n0: { note: c.note } } : null,
    }
  })
  const res = await jmapCall(
    apiUrl,
    [['ContactCard/set', { accountId, create }, 's']],
    [CORE, CONTACTS],
  )
  return Object.values(res.methodResponses[0][1].created ?? {}).map((v) => v.id)
}

const DEMO_FOLDERS = ['Invoices', 'Photos', 'Travel']
// Long enough that the sizes beside them read like files rather than typos.
const DEMO_FILES = [
  {
    name: 'Release notes.md',
    type: 'text/markdown',
    text: [
      '# Release notes',
      '',
      '## Calendar',
      '',
      '- Events can be dragged to another time, day or length.',
      '- Birthdays from the contacts appear as a calendar of their own,',
      '  and can be switched off in the sidebar.',
      '',
      '## Mail',
      '',
      '- Swiping a row now says what letting go will do.',
      '- Push notifications can name the sender and subject.',
      '',
      '## Files',
      '',
      '- Images, text and PDFs preview in place.',
      '',
    ].join('\n'),
  },
  {
    name: 'Packing list.txt',
    type: 'text/plain',
    text: 'Passport\nCharger and adapter\nNoise-cancelling headphones\nCoffee\nThe good notebook\n',
  },
  {
    name: 'Quarterly report.txt',
    type: 'text/plain',
    text: 'Revenue is up eleven percent on the quarter.\nCosts are up nine.\nHeadcount unchanged.\n',
  },
]
/** Opened in the preview pane for the screenshot. */
const PREVIEW_FILE = 'Release notes.md'

async function uploadBlob(uploadUrl, accountId, text, type) {
  const res = await fetch(uploadUrl.replace('{accountId}', encodeURIComponent(accountId)), {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64'),
      'Content-Type': type,
    },
    body: text,
  })
  if (!res.ok) throw new Error(`upload ${res.status}`)
  return (await res.json()).blobId
}

async function createFiles(apiUrl, uploadUrl, accountId) {
  const create = {}
  DEMO_FOLDERS.forEach((name, i) => {
    create[`d${i}`] = { name, parentId: null, nodeType: 'directory' }
  })
  for (const [i, f] of DEMO_FILES.entries()) {
    create[`f${i}`] = {
      name: f.name,
      parentId: null,
      nodeType: 'file',
      blobId: await uploadBlob(uploadUrl, accountId, f.text, f.type),
      type: f.type,
    }
  }
  const res = await jmapCall(
    apiUrl,
    [['FileNode/set', { accountId, create }, 's']],
    [CORE, FILENODE],
  )
  return Object.values(res.methodResponses[0][1].created ?? {}).map((v) => v.id)
}

/**
 * Destroys what this run created.
 *
 * Failures are reported but never thrown: this runs in a `finally`, and an
 * unreachable server on the way out must not hide the error that got us there.
 */
async function destroyAll(apiUrl, accountId, made) {
  const jobs = [
    ['CalendarEvent', made.events, [CORE, CALENDARS]],
    ['ContactCard', made.contacts, [CORE, CONTACTS]],
    ['FileNode', made.files, [CORE, FILENODE]],
  ]
  for (const [type, ids, using] of jobs) {
    if (!ids?.length) continue
    try {
      await jmapCall(apiUrl, [[`${type}/set`, { accountId, destroy: ids }, 'd']], using)
      console.log(`Removed ${ids.length} demo ${type}(s).`)
    } catch (e) {
      console.error(`Could not remove demo ${type}s:`, e.message)
    }
  }
}

/** Composites the iframe screenshot onto the page screenshot via canvas — see the file header for why this is needed instead of a single page.screenshot(). */
async function composite(browser, baseBuffer, frameBuffer, box) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.setContent('<canvas id="c"></canvas>')
  const toDataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64')
  const resultDataUrl = await page.evaluate(
    async ({ baseUrl, frameUrl, box, viewport }) => {
      const canvas = document.getElementById('c')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = reject
          img.src = src
        })
      const [base, frame] = await Promise.all([loadImage(baseUrl), loadImage(frameUrl)])
      ctx.drawImage(base, 0, 0)
      ctx.drawImage(frame, box.x, box.y, box.width, box.height)
      return canvas.toDataURL('image/png')
    },
    { baseUrl: toDataUrl(baseBuffer), frameUrl: toDataUrl(frameBuffer), box, viewport: VIEWPORT },
  )
  await page.close()
  return Buffer.from(resultDataUrl.split(',')[1], 'base64')
}

/**
 * Every app, in one session per color scheme.
 *
 * One login rather than one per view: the first sync after signing in is the
 * slow part, and paying it four times over would double the run for nothing.
 */
async function shootAll(browser, scheme) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: VIEWPORT })
  const page = await ctx.newPage()
  await page.goto(BASE_URL)
  await page.getByPlaceholder('you@example.com').fill(EMAIL)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.locator('button[type="submit"]').click()

  const shots = {}

  // Mail, with a message open. The reading pane is the one view that needs
  // the compositing trick — see the file header.
  const row = page.getByText(OPEN_SUBJECT, { exact: false }).first()
  await row.click({ timeout: 30_000 }) // the first sync can take a few seconds
  await page.waitForTimeout(1500) // let the iframe finish painting
  const iframeEl = page.locator('iframe').first()
  const box = await iframeEl.boundingBox()
  const [baseBuffer, frameBuffer] = await Promise.all([page.screenshot(), iframeEl.screenshot()])
  shots.mail = await composite(browser, baseBuffer, frameBuffer, box)

  // Calendar, in the week view: it shows the time grid, which the month grid
  // cannot, and the demo events are laid out across this week for it.
  await page.getByRole('link', { name: 'Calendar' }).first().click()
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.waitForTimeout(1200)
  shots.calendar = await page.screenshot()

  // Contacts, with a card open beside the list.
  await page.getByRole('link', { name: 'Contacts' }).first().click()
  await page
    .getByRole('link', { name: `${DEMO_CONTACTS[0].given} ${DEMO_CONTACTS[0].surname}` })
    .first()
    .click({ timeout: 15_000 })
  await page.waitForTimeout(800)
  shots.contacts = await page.screenshot()

  // Files, with a preview open: the browser alone is a list of names, and
  // previewing in place is the half worth showing.
  await page.getByRole('link', { name: 'Files' }).first().click()
  await page.getByText(PREVIEW_FILE, { exact: false }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(1200)
  shots.files = await page.screenshot()

  await ctx.close()
  return shots
}

async function main() {
  const { apiUrl, uploadUrl, accountId } = await jmapSession()
  const made = {}

  console.log(`Sending ${DEMO_MAIL.length} demo messages to ${EMAIL}...`)
  for (const mail of DEMO_MAIL) await sendMail(mail)

  const browser = await chromium.launch()
  try {
    console.log('Creating demo events, contacts and files...')
    made.events = await createEvents(apiUrl, accountId)
    made.contacts = await createContacts(apiUrl, accountId)
    made.files = await createFiles(apiUrl, uploadUrl, accountId)

    await mkdir(OUT_DIR, { recursive: true })
    for (const scheme of /** @type {const} */ (['dark', 'light'])) {
      console.log(`Shooting ${scheme}...`)
      const shots = await shootAll(browser, scheme)
      for (const [view, png] of Object.entries(shots)) {
        const out = path.join(OUT_DIR, `screenshot-${view}-${scheme}.png`)
        await writeFile(out, png)
        console.log(`Wrote ${path.relative(ROOT, out)}`)
      }
    }
  } finally {
    await browser.close()
    console.log('Cleaning up demo data...')
    const ids = await findDemoIds(apiUrl, accountId)
    await destroyIds(apiUrl, accountId, ids)
    console.log(`Removed ${ids.length} demo message(s).`)
    await destroyAll(apiUrl, accountId, made)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
