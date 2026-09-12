/*
 * Resets the shared Stalwart dev account to the seeded baseline before a run.
 *
 * Every spec talks to the same account, and several of them legitimately leave
 * artifacts behind: the draft-autosave test *must* leave a draft, sending
 * leaves a copy in Sent, and any test that fails mid-way skips its own
 * cleanup. Those pile up run over run until the initial sync is slow enough
 * that the suite's waits start expiring — which looks like random flakiness.
 *
 * Purges drafts, sent mail, custom folders, calendar events and contacts, and
 * trims the inbox back to the seeded messages the specs assert on. That last
 * part matters since the RSVP test: scheduling replies ("Accepted: …") are
 * delivered as real mail, and once a handful pile up at the top of the inbox
 * the virtualized list stops rendering the seeded subjects at all.
 */

const BASE = 'http://localhost:8080'
const ACCOUNTS = [
  { user: 'alice@localhost', pass: 'korrekt-pferd-batterie-alice' },
  { user: 'bob@localhost', pass: 'korrekt-pferd-batterie-bob' },
]

const CORE = 'urn:ietf:params:jmap:core'
const MAIL = 'urn:ietf:params:jmap:mail'
const CALENDARS = 'urn:ietf:params:jmap:calendars'
const CONTACTS = 'urn:ietf:params:jmap:contacts'

/** Everything else in the inbox is debris from an earlier run. */
const SEEDED_INBOX = new Set([
  'Willkommen bei mel',
  'Projektstand',
  'Re: Projektstand',
  'HTML-Test',
  'Mit Anhang',
  'Newsletter-Test',
])

/*
 * What each account must still have. Specs assert on these subjects by name, so
 * a missing one surfaces as an unrelated test failing for no visible reason —
 * which has happened repeatedly after a mailbox was destroyed with
 * onDestroyRemoveEmails, taking mail that lived only there with it. Failing
 * here instead names the missing message straight away.
 */
const EXPECTED_INBOX: Record<string, string[]> = {
  'alice@localhost': [
    'Willkommen bei mel',
    'Projektstand',
    'HTML-Test',
    'Mit Anhang',
    'Newsletter-Test',
  ],
  'bob@localhost': ['Re: Projektstand'],
}

type Invocation = [string, Record<string, unknown>, string]

async function jmap(auth: string, using: string[], methodCalls: Invocation[]) {
  const res = await fetch(`${BASE}/jmap/`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using, methodCalls }),
  })
  if (!res.ok) throw new Error(`JMAP ${res.status}`)
  return (await res.json()) as { methodResponses: Invocation[] }
}

async function resetAccount(user: string, pass: string) {
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  const session = (await (
    await fetch(`${BASE}/jmap/session`, { headers: { Authorization: auth } })
  ).json()) as { primaryAccounts: Record<string, string> }

  const mailAcc = session.primaryAccounts[MAIL]
  const calAcc = session.primaryAccounts[CALENDARS]
  const conAcc = session.primaryAccounts[CONTACTS]
  const removed: string[] = []

  if (mailAcc) {
    const boxes = (
      await jmap(auth, [CORE, MAIL], [['Mailbox/get', { accountId: mailAcc, ids: null }, 'c0']])
    ).methodResponses[0]![1] as { list: Array<{ id: string; role: string | null; name: string }> }

    // Mail in Drafts/Sent, plus anything in folders the tests created.
    const purgeRoles = new Set(['drafts', 'sent'])
    const custom = boxes.list.filter((b) => b.role === null)
    const purgeBoxIds = boxes.list
      .filter((b) => purgeRoles.has(b.role ?? ''))
      .map((b) => b.id)
      .concat(custom.map((b) => b.id))

    for (const boxId of purgeBoxIds) {
      const q = (
        await jmap(
          auth,
          [CORE, MAIL],
          [['Email/query', { accountId: mailAcc, filter: { inMailbox: boxId } }, 'c0']],
        )
      ).methodResponses[0]![1] as { ids: string[] }
      if (q.ids.length) {
        await jmap(
          auth,
          [CORE, MAIL],
          [['Email/set', { accountId: mailAcc, destroy: q.ids }, 'c0']],
        )
        removed.push(`${q.ids.length} mail`)
      }
    }
    // Junk back to the inbox first: the spam specs park a seeded message there,
    // and a run that fails midway would otherwise leave it out of the inbox and
    // trip the EXPECTED_INBOX check below for reasons that look unrelated.
    const junk = boxes.list.find((b) => b.role === 'junk')
    const inboxBox = boxes.list.find((b) => b.role === 'inbox')
    if (junk && inboxBox) {
      const stuck = (
        await jmap(
          auth,
          [CORE, MAIL],
          [['Email/query', { accountId: mailAcc, filter: { inMailbox: junk.id } }, 'c0']],
        )
      ).methodResponses[0]![1] as { ids: string[] }
      if (stuck.ids.length) {
        await jmap(
          auth,
          [CORE, MAIL],
          [
            [
              'Email/set',
              {
                accountId: mailAcc,
                update: Object.fromEntries(
                  stuck.ids.map((id) => [id, { mailboxIds: { [inboxBox.id]: true } }]),
                ),
              },
              'c0',
            ],
          ],
        )
        removed.push(`${stuck.ids.length} mail out of junk`)
      }
    }

    const inbox = boxes.list.find((b) => b.role === 'inbox')
    if (inbox) {
      const found = (
        await jmap(
          auth,
          [CORE, MAIL],
          [
            ['Email/query', { accountId: mailAcc, filter: { inMailbox: inbox.id } }, 'c0'],
            [
              'Email/get',
              {
                accountId: mailAcc,
                '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' },
                properties: ['subject'],
              },
              'c1',
            ],
          ],
        )
      ).methodResponses[1]![1] as { list: Array<{ id: string; subject: string | null }> }
      const subjects = found.list.map((m) => (m.subject ?? '').trim())
      const missing = (EXPECTED_INBOX[user] ?? []).filter((s) => !subjects.includes(s))
      if (missing.length) {
        throw new Error(
          `${user} is missing seeded mail: ${missing.join(', ')}. ` +
            'Specs assert on these by subject. Restore them (see the reset steps in ' +
            'the README) before running the suite — seed.sh will not top up a ' +
            'partially populated mailbox.',
        )
      }

      const strays = found.list
        .filter((m) => !SEEDED_INBOX.has((m.subject ?? '').trim()))
        .map((m) => m.id)
      if (strays.length) {
        await jmap(
          auth,
          [CORE, MAIL],
          [['Email/set', { accountId: mailAcc, destroy: strays }, 'c0']],
        )
        removed.push(`${strays.length} stray inbox mail`)
      }

      /*
       * A flag left behind by an earlier run is invisible debris: nothing looks
       * wrong, but any spec asserting "only this message is flagged" then sees
       * someone else's leftovers and fails somewhere unrelated.
       */
      const flagged = (
        await jmap(
          auth,
          [CORE, MAIL],
          [
            [
              'Email/query',
              { accountId: mailAcc, filter: { inMailbox: inbox.id, hasKeyword: '$flagged' } },
              'c0',
            ],
          ],
        )
      ).methodResponses[0]![1] as { ids: string[] }
      if (flagged.ids.length) {
        await jmap(
          auth,
          [CORE, MAIL],
          [
            [
              'Email/set',
              {
                accountId: mailAcc,
                update: Object.fromEntries(
                  flagged.ids.map((id) => [id, { 'keywords/$flagged': null }]),
                ),
              },
              'c0',
            ],
          ],
        )
        removed.push(`${flagged.ids.length} stale flag(s)`)
      }
    }

    if (custom.length) {
      await jmap(
        auth,
        [CORE, MAIL],
        [['Mailbox/set', { accountId: mailAcc, destroy: custom.map((b) => b.id) }, 'c0']],
      )
      removed.push(`${custom.length} folder(s)`)
    }
  }

  if (calAcc) {
    const events = (
      await jmap(
        auth,
        [CORE, CALENDARS],
        [['CalendarEvent/get', { accountId: calAcc, ids: null, properties: ['id'] }, 'c0']],
      )
    ).methodResponses[0]![1] as { list: Array<{ id: string }> }
    if (events.list.length) {
      await jmap(
        auth,
        [CORE, CALENDARS],
        [['CalendarEvent/set', { accountId: calAcc, destroy: events.list.map((e) => e.id) }, 'c0']],
      )
      removed.push(`${events.list.length} event(s)`)
    }
  }

  if (conAcc) {
    const cards = (
      await jmap(
        auth,
        [CORE, CONTACTS],
        [['ContactCard/get', { accountId: conAcc, ids: null, properties: ['id'] }, 'c0']],
      )
    ).methodResponses[0]![1] as { list: Array<{ id: string }> }
    if (cards.list.length) {
      await jmap(
        auth,
        [CORE, CONTACTS],
        [['ContactCard/set', { accountId: conAcc, destroy: cards.list.map((c) => c.id) }, 'c0']],
      )
      removed.push(`${cards.list.length} contact(s)`)
    }
  }

  console.log(`  ${user}: ${removed.length ? removed.join(', ') : 'already clean'}`)
}

export default async function globalSetup() {
  console.log('Resetting Stalwart test accounts to the seeded baseline…')
  for (const { user, pass } of ACCOUNTS) {
    try {
      await resetAccount(user, pass)
    } catch (e) {
      // A missing/unreachable server is the webServer's problem to report.
      console.warn(`  ${user}: reset skipped (${e instanceof Error ? e.message : e})`)
    }
  }
}
