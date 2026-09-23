import { createHmac } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

// Desktop-only (state-mutating, see playwright.config.ts).
const PASSWORD = 'korrekt-pferd-batterie-alice'

async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Willkommen bei mel')).toBeVisible({ timeout: 15_000 })
}

interface StoredCredentials {
  method: string
  secret: string
  tokenEndpoint?: string
}

/** The account row's credentials as they sit in IndexedDB (unencrypted). */
function storedCredentials(page: Page): Promise<{ credentials: StoredCredentials; raw: string }> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('mel')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const req = open.result.transaction('accounts').objectStore('accounts').getAll()
          req.onsuccess = () => {
            const row = (req.result as Array<{ payload: { plain: { credentials: unknown } } }>)[0]!
            open.result.close()
            resolve({
              credentials: row.payload.plain.credentials as StoredCredentials,
              raw: JSON.stringify(row),
            })
          }
        }
      }),
  )
}

/** Replaces the stored refresh token, as a server-side revocation would leave it. */
function spoilRefreshToken(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('mel')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const tx = open.result.transaction('accounts', 'readwrite')
          const store = tx.objectStore('accounts')
          const req = store.getAll()
          req.onsuccess = () => {
            const row = (
              req.result as Array<{ payload: { plain: { credentials: { secret: string } } } }>
            )[0]!
            row.payload.plain.credentials.secret = 'sw1.revoked'
            store.put(row)
          }
          tx.oncomplete = () => {
            open.result.close()
            resolve()
          }
        }
      }),
  )
}

test('stores a refresh token from Stalwart, never the password', async ({ page }) => {
  await login(page)
  const { credentials, raw } = await storedCredentials(page)
  expect(credentials.method).toBe('oauth')
  expect(credentials.secret).toMatch(/^sw1\./)
  expect(credentials.tokenEndpoint).toBe('http://localhost:8080/auth/token')
  expect(raw).not.toContain(PASSWORD)
})

test('a refused token asks to sign in again, and keeps the mail meanwhile', async ({ page }) => {
  await login(page)
  await spoilRefreshToken(page)
  // The access token lived in memory only; after a reload the spoilt refresh
  // token is all there is.
  await page.reload()

  const band = page.getByRole('status').filter({ hasText: 'Your sign-in has expired' })
  await expect(band).toBeVisible({ timeout: 15_000 })
  // What was synced before stays readable.
  await expect(page.getByText('Willkommen bei mel')).toBeVisible()

  await band.getByRole('button', { name: 'Sign in again' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign in again' })
  await dialog.getByLabel(/Password/).fill('not the password')
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog.getByText('Sign-in failed')).toBeVisible()

  await dialog.getByLabel(/Password/).fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Sign in' }).click()
  await expect(dialog).toBeHidden()
  await expect(band).toBeHidden({ timeout: 15_000 })

  const { credentials } = await storedCredentials(page)
  expect(credentials.secret).not.toBe('sw1.revoked')
  expect(credentials.secret).toMatch(/^sw1\./)
})

/** RFC 6238 code for a base32 secret, as an authenticator app would show it. */
function totpCode(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const mac = createHmac('sha1', key).update(counter).digest()
  const offset = mac[mac.length - 1]! & 15
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

test('an account with TOTP is asked for its code, then signed in', async ({ page }) => {
  // carol is provisioned by seed.sh with this fixed secret.
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('carol@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-carol')
  await page.getByRole('button', { name: 'Connect' }).click()

  const code = page.getByRole('textbox', { name: 'Verification code' })
  await expect(code).toBeVisible({ timeout: 15_000 })
  await expect(code).toBeFocused()

  await code.fill(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'))
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('link', { name: 'Inbox' })).toBeVisible({ timeout: 15_000 })

  const { credentials } = await storedCredentials(page)
  expect(credentials.method).toBe('oauth')
})
