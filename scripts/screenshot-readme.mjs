#!/usr/bin/env node
/**
 * Regenerates docs/media/screenshot-<view>-{light,dark}.png for the README,
 * and public/screenshots/install-{wide,narrow}.png for the manifest — the
 * images a browser shows in its install dialog. Same demo data, same login,
 * so they are one run rather than two scripts seeding the same account.
 *
 * One pair per view — mail, the invitation card, calendar, contacts, files,
 * notes — because a README that claims five apps and shows one is a README
 * that shows one.
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
/** Manifest screenshots are served, so they live with the other static files. */
const INSTALL_DIR = path.join(ROOT, 'public', 'screenshots')

const baseUrlFlagIndex = process.argv.indexOf('--base-url')
const BASE_URL =
  baseUrlFlagIndex !== -1
    ? process.argv[baseUrlFlagIndex + 1]
    : (process.env.MEL_SCREENSHOT_BASE_URL ?? 'http://localhost:5173')

const EMAIL = 'alice@localhost'
const PASSWORD = 'korrekt-pferd-batterie-alice'
const VIEWPORT = { width: 1440, height: 900 }
/*
 * The phone the install screenshot is taken on. Chrome wants every screenshot
 * of one form factor to share an aspect ratio, and none of them to be narrower
 * than 1:2.3 — 430×932 is a current large phone and lands inside that.
 */
const PHONE_VIEWPORT = { width: 430, height: 932 }

const THREAD_ROOT = `<design-review.${Date.now()}@screenshot-readme>`
const THREAD_SUBJECT = 'Design review: new inbox layout'
const INVITE_SUBJECT = 'Invitation: Coffee and a catch-up'

/** The event the invitation carries, as an iMIP REQUEST. */
function inviteIcs() {
  const d = new Date(mondayOfThisWeek())
  d.setDate(d.getDate() + 1)
  const stamp = (hour) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}0000`
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mel//screenshot//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:screenshot-invite-${Date.now()}@example.com`,
    `DTSTAMP:${stamp(9)}Z`,
    `DTSTART:${stamp(15)}`,
    `DTEND:${stamp(16)}`,
    'SUMMARY:Coffee and a catch-up',
    'LOCATION:Café Einstein, Berlin',
    'ORGANIZER;CN=Elena Vogt:mailto:elena.vogt@example.com',
    `ATTENDEE;CN=Alice;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${EMAIL}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n')
}

// A believable little inbox — plain text, no markup, so it also doubles as a
// check that plain-text mail follows the app's theme (the original bug this
// script was written to catch: Stalwart mirrors a plain-text part into
// `htmlBody` per RFC 8621 §4.1.4, and mel used to treat that as real HTML and
// render it on a fixed white background — see toEmailBody() / htmlPartText()
// in src/providers/jmap/mappers/mail.ts).
//
// The last three form one thread, so the list shows a conversation row and the
// reading pane shows it folded together; the invitation carries a real
// text/calendar part, which is what the pane offers a calendar for.
const DEMO_MAIL = [
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
    from: 'Elena Vogt <elena.vogt@example.com>',
    subject: INVITE_SUBJECT,
    body: 'Tuesday afternoon works for me — put something in the calendar, see you there!',
    calendar: inviteIcs(),
  },
  {
    from: 'Priya Nair <priya.nair@example.com>',
    subject: THREAD_SUBJECT,
    id: THREAD_ROOT,
    body: 'Hi Alice, Could you take a look at the updated conversation view before Thursday? I think grouping replies really helps. Thanks, Priya',
  },
  {
    from: 'Tom Walsh <tom.walsh@example.com>',
    subject: `Re: ${THREAD_SUBJECT}`,
    inReplyTo: THREAD_ROOT,
    body: 'Had a look this morning. The folded replies are a real improvement — one row per exchange instead of nine.',
  },
  {
    from: 'Priya Nair <priya.nair@example.com>',
    subject: `Re: ${THREAD_SUBJECT}`,
    inReplyTo: THREAD_ROOT,
    body: 'Good. I will take the spacing notes into the next pass and send it round on Thursday.',
  },
]
// Which one is open in the reading pane for the screenshot.
const OPEN_SUBJECT = THREAD_SUBJECT

/** Message-ids are referenced by the replies, so they are decided up front. */
const msgId = (tag) => `<${tag}.${Date.now()}@screenshot-readme>`

/**
 * One message, over plain SMTP against the dev Stalwart.
 *
 * `inReplyTo` is what makes a thread a thread: the server groups on
 * References, and mel's conversation rows follow the threadId it hands back.
 * `calendar` wraps the body in a multipart so the event travels as its own
 * part — which is what the reading pane looks for before offering it.
 */
async function sendMail({ from, subject, body, id, inReplyTo, calendar }) {
  const headers = [
    `From: ${from}`,
    `To: ${EMAIL}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id ?? msgId(Math.random().toString(36).slice(2))}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
  ]
  let msg
  if (calendar) {
    const boundary = 'melshot-boundary'
    headers.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`)
    msg =
      `${headers.join('\r\n')}\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n` +
      `--${boundary}\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST; name="invite.ics"\r\n` +
      `Content-Disposition: attachment; filename="invite.ics"\r\n\r\n` +
      `${calendar.replace(/\n/g, '\r\n')}\r\n` +
      `--${boundary}--\r\n`
  } else {
    msg = `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
  }
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
    // Day of the week the calendar is showing, so the birthday lands in it.
    birthdayOn: 2,
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
    birthdayOn: 4,
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

/** A birth anniversary on that weekday of the week the calendar is showing. */
function birthdayOn(weekday) {
  const d = new Date(mondayOfThisWeek())
  d.setDate(d.getDate() + weekday)
  return {
    a0: {
      '@type': 'Anniversary',
      kind: 'birth',
      date: { '@type': 'PartialDate', year: 1988, month: d.getMonth() + 1, day: d.getDate() },
    },
  }
}

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
      anniversaries: c.birthdayOn === undefined ? null : birthdayOn(c.birthdayOn),
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

/*
 * Notes ride on FileNode too — a folder per note holding `note.md`, front
 * matter and all (see src/lib/noteFile.ts) — but this script talks raw JMAP
 * rather than the app's own modules, so the file format is duplicated here
 * rather than imported.
 */
const NOTES_ROOT_NAME = 'Notes'
const NOTE_FILE_NAME = 'note.md'
const DEMO_NOTES = [
  {
    title: 'Grocery run',
    pinned: true,
    body: '# Grocery run\n\n- [ ] Milk\n- [ ] Bread\n- [x] Coffee\n',
  },
  {
    title: 'Trip to Lisbon',
    body: 'Flights booked for **March 14–18**. Still need:\n\n- [ ] Book the hotel\n- [ ] Print boarding passes\n',
  },
  {
    title: 'Standup notes',
    body: '- Migration planning kicked off this week.\n- Design review moved to Thursday.\n',
  },
]
/** Opened in the editor pane for the screenshot. */
const OPEN_NOTE = 'Grocery run'

/** Same shape as serializeNote() in src/lib/noteFile.ts. */
function noteFileText({ title, pinned, body }) {
  const fields = [`title: ${title}`]
  if (pinned) fields.push('pinned: true')
  return `---\n${fields.join('\n')}\n---\n\n${body}`
}

/** A readable, unique-enough folder name, mirroring noteFolderName() in src/lib/noteFile.ts. */
function noteFolderName(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'note'}-${Math.random().toString(36).slice(2, 6)}`
}

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
 * Notes' demo data: a `Notes` folder (reused if the account already has one —
 * this script must not create a second, conflicting root) with one
 * subfolder-plus-`note.md` per note, notesRoot()/noteFolders() in
 * src/sync/notes.ts's shape. Returns what this run itself created, so cleanup
 * only ever touches that — never a pre-existing `Notes` folder or its
 * contents.
 */
async function createNotes(apiUrl, uploadUrl, accountId) {
  const { methodResponses } = await jmapCall(
    apiUrl,
    [
      ['FileNode/query', { accountId, filter: { isTopLevel: true } }, 'q'],
      [
        'FileNode/get',
        { accountId, '#ids': { resultOf: 'q', name: 'FileNode/query', path: '/ids' } },
        'g',
      ],
    ],
    [CORE, FILENODE],
  )
  const topLevel = methodResponses[1][1].list
  const existingRoot = topLevel.find(
    (n) => n.name === NOTES_ROOT_NAME && n.nodeType === 'directory',
  )

  let rootId = existingRoot?.id
  let createdRoot = null
  if (!rootId) {
    const res = await jmapCall(
      apiUrl,
      [
        [
          'FileNode/set',
          { accountId, create: { r: { name: NOTES_ROOT_NAME, parentId: null, nodeType: 'directory' } } },
          's',
        ],
      ],
      [CORE, FILENODE],
    )
    rootId = res.methodResponses[0][1].created.r.id
    createdRoot = rootId
  }

  const folders = []
  const files = []
  for (const note of DEMO_NOTES) {
    const folderRes = await jmapCall(
      apiUrl,
      [
        [
          'FileNode/set',
          { accountId, create: { f: { name: noteFolderName(note.title), parentId: rootId, nodeType: 'directory' } } },
          's',
        ],
      ],
      [CORE, FILENODE],
    )
    const folderId = folderRes.methodResponses[0][1].created.f.id
    folders.push(folderId)

    const blobId = await uploadBlob(uploadUrl, accountId, noteFileText(note), 'text/markdown')
    const fileRes = await jmapCall(
      apiUrl,
      [
        [
          'FileNode/set',
          {
            accountId,
            create: {
              m: { name: NOTE_FILE_NAME, parentId: folderId, nodeType: 'file', blobId, type: 'text/markdown' },
            },
          },
          's',
        ],
      ],
      [CORE, FILENODE],
    )
    files.push(fileRes.methodResponses[0][1].created.m.id)
  }

  return { root: createdRoot, folders, files }
}

/**
 * Destroys the note folders/files this run created — deepest first, one
 * `FileNode/set` call per level, the same rule `deleteNodes` follows in
 * src/features/files/tree.ts: a parent and child destroyed in the same call
 * fail both (see docs/notes/filenode.md). The `Notes` root itself is only
 * destroyed if this run created it — a pre-existing one holds someone's real
 * notes and must survive the cleanup.
 */
async function destroyNotes(apiUrl, accountId, notes) {
  if (!notes) return
  for (const [label, ids] of [
    ['note file', notes.files],
    ['note folder', notes.folders],
    ['Notes root', notes.root ? [notes.root] : []],
  ]) {
    if (!ids.length) continue
    try {
      await jmapCall(apiUrl, [['FileNode/set', { accountId, destroy: ids }, 'd']], [CORE, FILENODE])
      console.log(`Removed ${ids.length} demo ${label}(s).`)
    } catch (e) {
      console.error(`Could not remove demo ${label}s:`, e.message)
    }
  }
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
async function composite(browser, baseBuffer, frameBuffer, box, viewport = VIEWPORT) {
  const page = await browser.newPage({ viewport })
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
    { baseUrl: toDataUrl(baseBuffer), frameUrl: toDataUrl(frameBuffer), box, viewport },
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
async function signIn(page) {
  await page.goto(BASE_URL)
  await page.getByPlaceholder('you@example.com').fill(EMAIL)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.locator('button[type="submit"]').click()
}

/** Opens the demo message and shoots the reading pane, iframe and all. */
async function openMailShot(browser, page, viewport = VIEWPORT) {
  const row = page.getByText(OPEN_SUBJECT, { exact: false }).first()
  await row.click({ timeout: 30_000 }) // the first sync can take a few seconds
  await page.waitForTimeout(1500) // let the iframe finish painting
  const iframeEl = page.locator('iframe').first()
  const box = await iframeEl.boundingBox()
  const [baseBuffer, frameBuffer] = await Promise.all([page.screenshot(), iframeEl.screenshot()])
  return composite(browser, baseBuffer, frameBuffer, box, viewport)
}

async function shootAll(browser, scheme) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: VIEWPORT })
  const page = await ctx.newPage()
  await signIn(page)

  const shots = {}

  // Mail, with a message open. The reading pane is the one view that needs
  // the compositing trick — see the file header.
  shots.mail = await openMailShot(browser, page)

  // The invitation, with the card the reading pane offers for a text/calendar
  // part. Its own shot rather than the mail one, because the conversation is
  // what the mail screenshot is for.
  await page.getByText(INVITE_SUBJECT, { exact: false }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  const inviteFrame = page.locator('iframe').first()
  const inviteBox = await inviteFrame.boundingBox()
  const [inviteBase, inviteInner] = await Promise.all([page.screenshot(), inviteFrame.screenshot()])
  shots.invitation = await composite(browser, inviteBase, inviteInner, inviteBox)

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

  // Notes, with the live Markdown editor open on the pinned checklist: the
  // list alone is titles and pins, and the editor rendering markup inline is
  // the point of the feature.
  await page.getByRole('link', { name: 'Notes' }).first().click()
  await page.getByRole('link', { name: OPEN_NOTE }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(1000)
  shots.notes = await page.screenshot()

  await ctx.close()
  return shots
}

/**
 * The two screenshots the browser shows in its install dialog.
 *
 * Always dark, because the manifest's `theme_color` and `background_color`
 * are, and the dialog draws them against it. Desktop gets a message open,
 * phone gets the list: on that width they are separate screens, and the list
 * is the one that says what the app is.
 */
async function shootInstall(browser) {
  const shots = {}

  const wide = await browser.newContext({ colorScheme: 'dark', viewport: VIEWPORT })
  const widePage = await wide.newPage()
  await signIn(widePage)
  shots['install-wide'] = await openMailShot(browser, widePage)
  await wide.close()

  const narrow = await browser.newContext({
    colorScheme: 'dark',
    viewport: PHONE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  })
  const narrowPage = await narrow.newPage()
  await signIn(narrowPage)
  await narrowPage.getByText(OPEN_SUBJECT, { exact: false }).first().waitFor({ timeout: 30_000 })
  await narrowPage.waitForTimeout(1200)
  shots['install-narrow'] = await narrowPage.screenshot()
  await narrow.close()

  return shots
}

async function main() {
  const { apiUrl, uploadUrl, accountId } = await jmapSession()
  const made = {}

  console.log(`Sending ${DEMO_MAIL.length} demo messages to ${EMAIL}...`)
  for (const mail of DEMO_MAIL) await sendMail(mail)

  const browser = await chromium.launch()
  try {
    console.log('Creating demo events, contacts, files and notes...')
    made.events = await createEvents(apiUrl, accountId)
    made.contacts = await createContacts(apiUrl, accountId)
    made.files = await createFiles(apiUrl, uploadUrl, accountId)
    made.notes = await createNotes(apiUrl, uploadUrl, accountId)

    await mkdir(OUT_DIR, { recursive: true })
    await mkdir(INSTALL_DIR, { recursive: true })
    console.log('Shooting the install screenshots...')
    for (const [view, png] of Object.entries(await shootInstall(browser))) {
      const out = path.join(INSTALL_DIR, `${view}.png`)
      await writeFile(out, png)
      console.log(`Wrote ${path.relative(ROOT, out)}`)
    }
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
    await destroyNotes(apiUrl, accountId, made.notes)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
