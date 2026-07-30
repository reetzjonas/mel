import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
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

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const { registerSW } = await import('virtual:pwa-register')
  registerSW({ immediate: true })
}
