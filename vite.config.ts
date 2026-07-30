import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
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
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
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
