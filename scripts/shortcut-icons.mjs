#!/usr/bin/env node
/**
 * Regenerates public/shortcut-<name>-96.png, the icons beside the manifest's
 * three app shortcuts (long-press / right-click the installed app).
 *
 * Run it after changing a glyph or the brand colour:
 *   node scripts/shortcut-icons.mjs
 *
 * They have to be bitmaps at a declared size: Chrome's manifest icon
 * downloader decodes images without a renderer, so it cannot rasterize an SVG
 * (the same reason the manifest no longer points at favicon.svg), and it wants
 * 96×96 for shortcuts specifically. So the glyph is drawn as SVG and put
 * through the browser we already have as a dev dependency, rather than adding
 * a native image library for three small files.
 *
 * The paths are the same Lucide glyphs the app draws for these three places
 * (`compose`, `calendar`, `contact` in src/ui/Icon.tsx), copied rather than
 * imported because that module is TSX and this script is plain node. They are
 * static brand assets: if a glyph in the app changes and these are not
 * regenerated, the shortcut simply keeps the older drawing.
 */

import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public')

/** The violet of the app icon (public/favicon.svg, `.mark`). */
const BRAND = '#471b6f'
const SIZE = 96

const SHORTCUTS = {
  compose:
    'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7m-1.5-8.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z',
  calendar:
    'M8 2v4m8-4v4M3.5 9.5h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 5Z',
  contact: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 10v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2',
}

/*
 * 24-unit glyph on a 40-unit tile: the launcher draws these small, and a
 * glyph that runs to the edge of its own rounded square reads as a smudge.
 */
const svg = (
  d,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${SIZE}" height="${SIZE}">
  <rect width="40" height="40" rx="9" fill="${BRAND}"/>
  <g transform="translate(8 8)" fill="none" stroke="#fff" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g>
</svg>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  })
  for (const [name, d] of Object.entries(SHORTCUTS)) {
    await page.setContent(`<body style="margin:0;background:transparent">${svg(d)}</body>`)
    const png = await page.screenshot({ omitBackground: true })
    const file = path.join(OUT_DIR, `shortcut-${name}-96.png`)
    await writeFile(file, png)
    console.log('wrote', path.relative(ROOT, file))
  }
} finally {
  await browser.close()
}
