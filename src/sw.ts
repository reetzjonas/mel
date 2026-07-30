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
