import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
// Self-hosted: a backend-less, privacy-minded client shouldn't phone a font CDN.
import '@fontsource-variable/inter'
import './index.css'
import { ThemeProvider } from './app/ThemeProvider'
import { routeTree } from './app/routeTree.gen'

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

import('./sync/outbox').then(({ useOutboxAutoFlush }) => useOutboxAutoFlush())

// Load the per-account encryption flags before anything reads the store.
const { initEncryptionState } = await import('./services/encryption')
await initEncryptionState()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
)

// Ask the browser not to evict our IndexedDB under storage pressure —
// the outbox may hold unsent mail.
if (navigator.storage?.persist) void navigator.storage.persist()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const { registerSW } = await import('virtual:pwa-register')
  const { useUi } = await import('./app/store')
  const { t } = await import('./lib/i18n')
  const updateSW = registerSW({
    onNeedRefresh() {
      useUi.getState().showSnackbar(
        {
          message: t('app.updateAvailable'),
          actionLabel: t('app.reload'),
          action: () => void updateSW(true),
        },
        60_000,
      )
    },
  })
}
