import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import * as openpgp from 'openpgp'

// Desktop-only (see testIgnore in playwright.config.ts): it adds a contact
// and mail to the shared account.

const ALICE = ['alice@localhost', 'korrekt-pferd-batterie-alice'] as const
const PASS = 'pgp-e2e-passphrase'
const headers = { Authorization: `Basic ${btoa(ALICE.join(':'))}` }
const USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:contacts',
]

async function jmap(request: APIRequestContext, calls: unknown[]) {
  const res = await request.post('http://localhost:8080/jmap', {
    headers,
    data: { using: USING, methodCalls: calls },
  })
  return ((await res.json()) as { methodResponses: [string, Record<string, unknown>][] })
    .methodResponses
}

async function accountIds(request: APIRequestContext) {
  const session = (await (
    await request.get('http://localhost:8080/jmap/session', { headers })
  ).json()) as { primaryAccounts: Record<string, string>; uploadUrl: string }
  return {
    mail: session.primaryAccounts['urn:ietf:params:jmap:mail']!,
    contacts: session.primaryAccounts['urn:ietf:params:jmap:contacts']!,
    uploadUrl: session.uploadUrl,
  }
}

/** A message delivered straight into Alice's inbox, as the raw bytes given. */
async function importMail(request: APIRequestContext, raw: string): Promise<string> {
  const ids = await accountIds(request)
  const upload = (await (
    await request.post(ids.uploadUrl.replace('{accountId}', ids.mail), {
      headers: { ...headers, 'Content-Type': 'message/rfc822' },
      data: Buffer.from(raw),
    })
  ).json()) as { blobId: string }
  const [[, inbox]] = (await jmap(request, [
    ['Mailbox/query', { accountId: ids.mail, filter: { role: 'inbox' } }, 'm'],
  ])) as [[string, { ids: string[] }]]
  const [[, imported]] = (await jmap(request, [
    [
      'Email/import',
      {
        accountId: ids.mail,
        emails: {
          x: { blobId: upload.blobId, mailboxIds: { [inbox.ids[0]!]: true }, keywords: {} },
        },
      },
      'i',
    ],
  ])) as [[string, { created: { x: { id: string } } }]]
  return imported.created.x.id
}

/** A contact card for `email` carrying the public half of `key`, which is where mel looks for it. */
async function addContactWithKey(
  request: APIRequestContext,
  email: string,
  key: openpgp.PrivateKey,
) {
  const ids = await accountIds(request)
  const [[, books]] = (await jmap(request, [
    ['AddressBook/get', { accountId: ids.contacts, ids: null }, 'a'],
  ])) as [[string, { list: { id: string }[] }]]
  const keyUri = `data:application/pgp-keys;base64,${Buffer.from(key.toPublic().armor()).toString('base64')}`
  await jmap(request, [
    [
      'ContactCard/set',
      {
        accountId: ids.contacts,
        create: {
          c: {
            '@type': 'Card',
            version: '1.0',
            addressBookIds: { [books.list[0]!.id]: true },
            name: { full: 'Bob PGP' },
            emails: { e: { address: email } },
            cryptoKeys: {
              k: { '@type': 'CryptoKey', uri: keyUri, mediaType: 'application/pgp-keys' },
            },
          },
        },
      },
      'c',
    ],
  ])
}

async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill(ALICE[0])
  await page.getByRole('textbox', { name: 'Password' }).fill(ALICE[1])
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: /^Inbox( \d+)?$/ })).toBeVisible({ timeout: 15_000 })
}

/*
 * The whole reading round trip: an encrypted, signed message arrives; mel
 * says it needs the key; the key is imported in Settings; the message opens
 * with the sender's signature checked against the key on their contact card;
 * and after a reload — the unlocked key lived in memory only — the band asks
 * for the passphrase and opens the message again.
 */
test('an encrypted, signed message opens once the key is imported, and asks again after a reload', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const subject = `e2e-pgp-${stamp}`
  const sender = `pgp-bob-${stamp}@example.com`

  const gen = async (email: string) =>
    (await openpgp.generateKey({ userIDs: [{ email }], format: 'object' })).privateKey
  const [alice, bob] = await Promise.all([gen(ALICE[0]), gen(sender)])
  const aliceArmored = (await openpgp.encryptKey({ privateKey: alice, passphrase: PASS })).armor()

  const ids = await accountIds(request)
  await addContactWithKey(request, sender, bob)

  const entity =
    'Content-Type: text/plain; charset=utf-8\r\n\r\nStreng geheim: der Kuchen ist im Schrank.\r\n'
  const cipher = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: entity }),
    encryptionKeys: alice.toPublic(),
    signingKeys: bob,
  })
  const B = `b${stamp}`
  const emailId = await importMail(
    request,
    [
      `From: Bob PGP <${sender}>`,
      `To: ${ALICE[0]}`,
      `Subject: ${subject}`,
      `Message-ID: <${subject}@example.com>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${B}"`,
      '',
      `--${B}`,
      'Content-Type: application/pgp-encrypted',
      '',
      'Version: 1',
      '',
      `--${B}`,
      'Content-Type: application/octet-stream; name="encrypted.asc"',
      '',
      cipher.replace(/\r?\n/g, '\r\n'),
      `--${B}--`,
      '',
    ].join('\r\n'),
  )

  try {
    await login(page)
    await page
      .getByRole('button', { name: new RegExp(subject) })
      .first()
      .click()
    await expect(page.getByText('This message is encrypted')).toBeVisible({ timeout: 15_000 })
    // The ciphertext is not offered as a file while the band speaks for it.
    await expect(page.getByRole('button', { name: /encrypted\.asc/ })).toHaveCount(0)

    await page.getByRole('button', { name: 'Open settings' }).click()
    await page.getByRole('button', { name: 'Import key' }).click()
    await page.getByLabel(/Paste your secret key/).fill(aliceArmored)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Enter the passphrase this key is protected with.')).toBeVisible()
    await page.getByRole('textbox', { name: 'Key passphrase' }).fill('not it')
    await page.getByRole('button', { name: 'Import key' }).click()
    await expect(page.getByText('Wrong passphrase for this key')).toBeVisible()
    await page.getByRole('textbox', { name: 'Key passphrase' }).fill(PASS)
    await page.getByRole('button', { name: 'Import key' }).click()
    await expect(page.getByText('Unlocked for this session')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Close settings' }).click()

    const frame = page.frameLocator('iframe[title="Message content"]')
    await expect(frame.getByText('Streng geheim: der Kuchen ist im Schrank.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(`Signed by <${sender}>`)).toBeVisible()
    await expect(page.getByText('The subject line was not encrypted.')).toBeVisible()

    // The unlocked key lived in this page's memory only.
    await page.reload()
    await expect(page.getByText('Enter your key passphrase to read it.')).toBeVisible({
      timeout: 15_000,
    })
    await page.getByRole('textbox', { name: 'Key passphrase' }).fill(PASS)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(frame.getByText('Streng geheim: der Kuchen ist im Schrank.')).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await jmap(request, [['Email/set', { accountId: ids.mail, destroy: [emailId] }, 'd']])
  }
})

/*
 * A signed message is checked against its raw bytes, fetched from the server
 * (the parts it lists have their headers stripped). One message as signed,
 * one altered after signing: the first names the signer, the second warns.
 */
test('a signed message names its signer, and an altered one says it does not match', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const stamp = Date.now()
  const sender = `pgp-signer-${stamp}@example.com`
  const bob = (await openpgp.generateKey({ userIDs: [{ email: sender }], format: 'object' }))
    .privateKey
  await addContactWithKey(request, sender, bob)
  const ids = await accountIds(request)

  const part = 'Content-Type: text/plain; charset=utf-8\r\n\r\nIch stimme zu.\r\n'
  const signature = await openpgp.sign({
    message: await openpgp.createMessage({ binary: Buffer.from(part) }),
    signingKeys: bob,
    detached: true,
  })
  const signed = (subject: string, content: string) =>
    [
      `From: ${sender}`,
      `To: ${ALICE[0]}`,
      `Subject: ${subject}`,
      `Message-ID: <${subject}@example.com>`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"; boundary="S"',
      '',
      '--S',
      content,
      '--S',
      'Content-Type: application/pgp-signature; name="signature.asc"',
      '',
      signature.replace(/\r?\n/g, '\r\n'),
      '--S--',
      '',
    ].join('\r\n')
  const good = `e2e-pgp-signed-${stamp}`
  const bad = `e2e-pgp-altered-${stamp}`
  const created = [
    await importMail(request, signed(good, part)),
    await importMail(request, signed(bad, part.replace('zu.', 'nicht zu.'))),
  ]

  try {
    await login(page)
    await page
      .getByRole('button', { name: new RegExp(good) })
      .first()
      .click()
    await expect(page.getByText(`Signed by <${sender}>`)).toBeVisible({ timeout: 15_000 })
    // The signature itself is not offered as a file.
    await expect(page.getByRole('button', { name: /signature\.asc/ })).toHaveCount(0)

    await page
      .getByRole('button', { name: new RegExp(bad) })
      .first()
      .click()
    await expect(page.getByText('The signature does not match')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/^Signed by/)).toHaveCount(0)
  } finally {
    await jmap(request, [['Email/set', { accountId: ids.mail, destroy: created }, 'd']])
  }
})
