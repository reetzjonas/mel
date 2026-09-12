import { expect, test, type Page } from '@playwright/test'

/*
 * The editor reads the shipped palette back out of the stylesheet with
 * getComputedStyle and writes overrides onto the root element. Neither half
 * is something jsdom resolves, so the derivation is unit-tested and the
 * wiring is proved here, in a browser that has the stylesheet.
 *
 * Touches only localStorage, so it is safe on both projects.
 */

async function login(page: Page) {
  await page.goto('/mail')
  await page.getByPlaceholder('you@example.com').fill('alice@localhost')
  await page.getByRole('textbox', { name: 'Password' }).fill('korrekt-pferd-batterie-alice')
  await page.getByRole('button', { name: 'Connect' }).click()
}

/** A token as the page actually resolves it, overrides and all. */
const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)

/** The hue component of an `oklch(L C H)` value. */
const hueOf = (value: string) => Number(/oklch\(\s*[\d.]+\s+[\d.]+\s+([\d.]+)/.exec(value)?.[1])

test('a hue chosen in settings reaches the app, survives a reload, and resets', async ({
  page,
}) => {
  await login(page)
  await expect(
    page.locator('[data-testid="virtuoso-item-list"] [role="button"]').first(),
  ).toBeVisible({ timeout: 15_000 })

  const shipped = await token(page, '--mel-accent')
  expect(hueOf(shipped)).toBeCloseTo(292, 0)

  await page.goto('/mail?settings=appearance')
  /*
   * 200° on purpose: clear of every hue this test checks against — danger 25,
   * honey 72, success 150, and the shipped accent at 292. A chosen hue that
   * collided with one of them would let "untouched" and "retinted" look the
   * same, and the assertion below would pass for the wrong reason.
   */
  const accentHue = page.getByRole('slider', { name: 'Accent hue' })
  await accentHue.fill('200')

  // Applied live: no Save, and the app behind the dialog is the preview.
  await expect(async () => {
    expect(hueOf(await token(page, '--mel-accent'))).toBeCloseTo(200, 0)
  }).toPass()

  // The whole accent family moves together, washes included.
  expect(hueOf(await token(page, '--mel-accent-hover'))).toBeCloseTo(200, 0)
  expect(hueOf(await token(page, '--mel-accent-wash'))).toBeCloseTo(200, 0)

  /*
   * And the semantic colours do not. Their hue is their meaning — a green
   * "delete" would be a bug wearing the clothes of a preference.
   */
  expect(hueOf(await token(page, '--mel-danger'))).toBeCloseTo(25, 0)
  expect(hueOf(await token(page, '--mel-success'))).toBeCloseTo(150, 0)
  expect(hueOf(await token(page, '--mel-honey'))).toBeCloseTo(72, 0)

  await page.reload()
  await expect(async () => {
    expect(hueOf(await token(page, '--mel-accent'))).toBeCloseTo(200, 0)
  }).toPass()

  await page.goto('/mail?settings=appearance')
  await page.getByRole('button', { name: 'Back to the default palette' }).click()

  await expect(async () => {
    expect(await token(page, '--mel-accent')).toBe(shipped)
  }).toPass()
  // Forgotten, not stored as today's default — so the button has nothing left.
  await expect(page.getByRole('button', { name: 'Back to the default palette' })).toBeDisabled()
})

test('the tuning is re-derived for the other theme, not carried over', async ({ page }) => {
  /*
   * Light and dark share their hues but not their lightness, so the overrides
   * have to be rebuilt from whichever palette is in force. Carrying the light
   * values into dark mode would wash the whole app out.
   */
  await login(page)
  await page.goto('/mail?settings=appearance')
  await page.getByRole('slider', { name: 'Accent hue' }).fill('200')
  await expect(async () => {
    expect(hueOf(await token(page, '--mel-accent'))).toBeCloseTo(200, 0)
  }).toPass()

  const lightAccent = await token(page, '--mel-accent')
  const lightCanvas = await token(page, '--mel-canvas')

  await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark')

  await expect(async () => {
    const darkCanvas = await token(page, '--mel-canvas')
    // Dark really is dark: the lightness came from the dark palette.
    expect(darkCanvas).not.toBe(lightCanvas)
    expect(Number(/oklch\(\s*([\d.]+)/.exec(darkCanvas)?.[1])).toBeLessThan(0.3)
  }).toPass()

  // The chosen hue came along, even though the lightness did not.
  expect(hueOf(await token(page, '--mel-accent'))).toBeCloseTo(200, 0)
  expect(await token(page, '--mel-accent')).not.toBe(lightAccent)

  await page.getByRole('button', { name: 'Back to the default palette' }).click()
  await page.getByRole('combobox', { name: 'Theme' }).selectOption('system')
})

test('the contrast figures are measured and move with the sliders', async ({ page }) => {
  await login(page)
  await page.goto('/mail?settings=appearance')

  const body = page.getByText('Body text on the page')
  await expect(body).toBeVisible()
  const before = await body.locator('xpath=following-sibling::*[1]').innerText()

  // Saturating the neutrals hard: lightness is untouched, so a promise based
  // on the ladders alone would claim nothing changed. WCAG weights the sRGB
  // primaries, so the measured figure does move.
  await page.getByRole('slider', { name: 'Surface tint' }).fill('4')

  await expect(async () => {
    const after = await body.locator('xpath=following-sibling::*[1]').innerText()
    expect(after).not.toBe(before)
  }).toPass()

  await page.getByRole('button', { name: 'Back to the default palette' }).click()
})
