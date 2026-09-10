#!/usr/bin/env node
/**
 * Regenerates docs/media/screenshot-{light,dark}.png for the README.
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
 * screenshots the result. The demo messages are destroyed again at the
 * end (in a `finally`, so a crash mid-run doesn't leave them behind) —
 * this script must not alter what `npm run stalwart:seed` / e2e's
 * global-setup expect to find in the inbox.
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
  return { apiUrl: session.apiUrl, accountId }
}

async function jmapCall(apiUrl, methodCalls) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${EMAIL}:${PASSWORD}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    }),
  })
  return res.json()
}

/** Finds the ids of the messages this script just sent, by subject. */
async function findDemoIds(apiUrl, accountId) {
  const subjects = new Set(DEMO_MAIL.map((m) => m.subject))
  const data = await jmapCall(apiUrl, [
    ['Email/query', { accountId, sort: [{ property: 'receivedAt', isAscending: false }], limit: 20 }, 'q'],
    [
      'Email/get',
      { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject'] },
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

async function shootOne(browser, scheme) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: VIEWPORT })
  const page = await ctx.newPage()
  await page.goto(BASE_URL)
  await page.getByPlaceholder('you@example.com').fill(EMAIL)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.locator('button[type="submit"]').click()
  const row = page.getByText(OPEN_SUBJECT, { exact: false }).first()
  await row.click({ timeout: 30_000 }) // first sync after login can take a few seconds
  await page.waitForTimeout(1500) // let the iframe finish painting

  const iframeEl = page.locator('iframe').first()
  const box = await iframeEl.boundingBox()
  const [baseBuffer, frameBuffer] = await Promise.all([page.screenshot(), iframeEl.screenshot()])
  await ctx.close()

  return composite(browser, baseBuffer, frameBuffer, box)
}

async function main() {
  console.log(`Sending ${DEMO_MAIL.length} demo messages to ${EMAIL}...`)
  for (const mail of DEMO_MAIL) await sendMail(mail)

  const browser = await chromium.launch()
  try {
    await mkdir(OUT_DIR, { recursive: true })
    for (const scheme of /** @type {const} */ (['dark', 'light'])) {
      console.log(`Shooting ${scheme}...`)
      const png = await shootOne(browser, scheme)
      const out = path.join(OUT_DIR, `screenshot-${scheme}.png`)
      await writeFile(out, png)
      console.log(`Wrote ${path.relative(ROOT, out)}`)
    }
  } finally {
    await browser.close()
    console.log('Cleaning up demo messages...')
    const { apiUrl, accountId } = await jmapSession()
    const ids = await findDemoIds(apiUrl, accountId)
    await destroyIds(apiUrl, accountId, ids)
    console.log(`Removed ${ids.length} demo message(s).`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
