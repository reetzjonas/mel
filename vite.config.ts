import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MEL_')
  return {
    plugins: [
      tanstackRouter({
        target: 'react',
        routesDirectory: './src/app/routes',
        generatedRouteTree: './src/app/routeTree.gen.ts',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
      // Dev-only, opt-in: MEL_HTTPS=1 npm run dev -- --host
      // A LAN IP (as opposed to localhost) is not a secure context, so
      // crypto.subtle/randomUUID are missing and login throws. A self-signed
      // cert makes the origin secure — browsers still warn once, click through.
      env.MEL_HTTPS ? basicSsl() : undefined,
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        manifest: {
          name: 'mel',
          short_name: 'mel',
          description: 'JMAP webmail, calendar and contacts — no backend, local-first',
          start_url: '/',
          display: 'standalone',
          background_color: '#101014',
          theme_color: '#101014',
          /*
           * Bitmaps only. favicon.svg used to be listed first and Chrome
           * reported it as failing to load every time: its manifest icons go
           * through an image decoder with no renderer behind it, which cannot
           * rasterize SVG. The tab icon in index.html is still the SVG — that
           * one is loaded as a document resource and works everywhere.
           */
          icons: [
            { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
          ],
          /*
           * What a browser shows in its install dialog. One per form factor,
           * since the desktop and mobile dialogs each need their own and
           * Chrome offers the richer dialog only when it has them. Regenerated
           * by scripts/screenshot-readme.mjs along with the README's.
           */
          screenshots: [
            {
              src: '/screenshots/install-wide.png',
              sizes: '1440x900',
              type: 'image/png',
              form_factor: 'wide',
              label: 'A conversation open beside the inbox',
            },
            {
              src: '/screenshots/install-narrow.png',
              sizes: '430x932',
              type: 'image/png',
              form_factor: 'narrow',
              label: 'The inbox on a phone',
            },
          ],
          /*
           * The three ways the rest of the system can reach into mel once it
           * is installed. All of them land on /compose or an app route, which
           * are in scope because start_url is the origin root.
           *
           * The labels are English and stay that way: a manifest is one static
           * file written at build time, and it has no place to carry the
           * translations src/lib/i18n.ts picks from at runtime.
           */
          protocol_handlers: [{ protocol: 'mailto', url: '/compose?mailto=%s' }],
          share_target: {
            action: '/compose',
            method: 'GET',
            // The only encoding a GET share target may have, and the default —
            // spelled out because a share target that leaves it to the default
            // is flagged as relying on one.
            enctype: 'application/x-www-form-urlencoded',
            params: { title: 'subject', text: 'body', url: 'url' },
          },
          // 96×96 is the size launchers draw a shortcut at; see
          // scripts/shortcut-icons.mjs for where the files come from.
          shortcuts: [
            {
              name: 'New message',
              url: '/compose',
              icons: [{ src: '/shortcut-compose-96.png', sizes: '96x96', type: 'image/png' }],
            },
            {
              name: 'Calendar',
              url: '/calendar',
              icons: [{ src: '/shortcut-calendar-96.png', sizes: '96x96', type: 'image/png' }],
            },
            {
              name: 'Contacts',
              url: '/contacts',
              icons: [{ src: '/shortcut-contact-96.png', sizes: '96x96', type: 'image/png' }],
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    server: {
      // Dev-only escape hatch for JMAP servers without CORS:
      // MEL_PROXY_TARGET=https://mail.example.com npm run dev → requests via /jmap-proxy/*
      proxy: env.MEL_PROXY_TARGET
        ? {
            '/jmap-proxy': {
              target: env.MEL_PROXY_TARGET,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/jmap-proxy/, ''),
            },
          }
        : undefined,
    },
  }
})
