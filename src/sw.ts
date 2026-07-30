/// <reference lib="webworker" />
// App-shell service worker (injectManifest). Data lives in IndexedDB, never in SW
// caches — authenticated JMAP responses must not be cached here.
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting()
})

// Web Push (RFC 8620 §7.2 / RFC 9749): the JMAP server pushes PushVerification
// during subscription setup and StateChange objects afterwards.
self.addEventListener('push', (event) => {
  let data: Record<string, unknown> = {}
  try {
    data = event.data?.json() as Record<string, unknown>
  } catch {
    /* non-JSON push */
  }

  if (data['@type'] === 'PushVerification') {
    const bc = new BroadcastChannel('mel-push')
    bc.postMessage({
      type: 'PushVerification',
      pushSubscriptionId: data['pushSubscriptionId'],
      verificationCode: data['verificationCode'],
    })
    bc.close()
    return
  }

  if (data['@type'] === 'StateChange') {
    const changed = (data['changed'] ?? {}) as Record<string, Record<string, string>>
    const types = new Set<string>()
    for (const acc of Object.values(changed)) for (const t of Object.keys(acc)) types.add(t)
    // Only notify about new mail; open clients handle the rest via SSE.
    if (!types.has('Email') && !types.has('EmailDelivery')) return
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window' })
        if (clients.some((c) => c.visibilityState === 'visible')) return
        await self.registration.showNotification('mel', {
          body: 'New mail',
          tag: 'mel-push-mail',
          icon: '/icon.svg',
        })
      })(),
    )
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' })
      const existing = clients[0]
      if (existing) {
        await existing.focus()
        return
      }
      await self.clients.openWindow('/mail')
    })(),
  )
})
