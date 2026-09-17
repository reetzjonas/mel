/// <reference lib="webworker" />
// App-shell service worker (injectManifest). Data lives in IndexedDB, never in SW
// caches — authenticated JMAP responses must not be cached here.
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { showAppBadge } from './lib/appBadge'
import { t } from './lib/i18n'
import { mailNotificationFor } from './sw/mailNotification'

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
    // Only notify about new mail; open clients handle the rest via SSE.
    const mailAccounts = Object.entries(changed)
      .filter(([, types]) => 'Email' in types || 'EmailDelivery' in types)
      .map(([accountId]) => accountId)
    if (!mailAccounts.length) return
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window' })
        if (clients.some((c) => c.visibilityState === 'visible')) return
        /*
         * A flag rather than a number: the push says only that mail changed,
         * and the stored count is whatever the last sync saw, so any figure
         * here would be a guess. The app replaces it with the real count the
         * moment it is opened.
         */
        showAppBadge()
        // Naming the message is opt-in and costs a round trip, so the generic
        // body is both the default and the answer to anything going wrong.
        const detail =
          mailAccounts.length === 1 ? await mailNotificationFor(mailAccounts[0]!) : null
        await self.registration.showNotification(detail?.title ?? 'mel', {
          body: detail?.body ?? t('push.newMail'),
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
