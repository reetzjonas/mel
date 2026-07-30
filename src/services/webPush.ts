import { Batch } from '../providers/jmap/client/request'
import { createTransport } from '../providers/jmap/client/transport'
import { fetchSession } from '../providers/jmap/client/session'
import { Cap, type GetResponse, type SetResponse } from '../providers/jmap/client/types/core'
import { connectionFor, storedAccount } from '../sync/connections'

/**
 * Web Push via JMAP PushSubscription (RFC 8620 §7.2) + VAPID (RFC 9749):
 * the JMAP server itself posts StateChange to the browser's push service —
 * no app backend involved. Flow: subscribe with the server's
 * applicationServerKey → PushSubscription/set create (url + encryption keys)
 * → server sends a PushVerification through the push pipe → the service
 * worker broadcasts it back → PushSubscription/set update verificationCode.
 */

const DEVICE_ID_KEY = 'mel:pushDeviceId'

function deviceClientId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function transportFor(accountId: string) {
  const { account, credentials } = await storedAccount(accountId)
  const resolved = await fetchSession(account.sessionUrl, credentials)
  const vapid = resolved.session.capabilities[Cap.webpushVapid] as
    | { applicationServerKey: string }
    | undefined
  return {
    transport: createTransport(resolved.apiUrl, credentials),
    applicationServerKey: vapid?.applicationServerKey ?? null,
  }
}

export async function webPushSupported(accountId: string): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  const conn = await connectionFor(accountId)
  return conn.capabilities.webPush
}

export async function isSubscribed(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false
  const reg = await navigator.serviceWorker.getRegistration()
  return Boolean(await reg?.pushManager.getSubscription())
}

export async function enableWebPush(accountId: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready
  const { transport, applicationServerKey } = await transportFor(accountId)
  if (!applicationServerKey) throw new Error('Server has no VAPID key (RFC 9749)')

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  })
  const p256dh = sub.getKey('p256dh')
  const auth = sub.getKey('auth')
  if (!p256dh || !auth) throw new Error('Push subscription without encryption keys')

  // The SW broadcasts the PushVerification it receives from the push pipe.
  const verification = new Promise<{ id: string; code: string }>((resolve, reject) => {
    const bc = new BroadcastChannel('mel-push')
    const timer = setTimeout(() => {
      bc.close()
      reject(new Error('Push verification timed out'))
    }, 30_000)
    bc.onmessage = (ev) => {
      const d = ev.data as { type?: string; pushSubscriptionId?: string; verificationCode?: string }
      if (d?.type === 'PushVerification' && d.pushSubscriptionId && d.verificationCode) {
        clearTimeout(timer)
        bc.close()
        resolve({ id: d.pushSubscriptionId, code: d.verificationCode })
      }
    }
  })

  const b = new Batch(transport, [Cap.core])
  const create = b.call<SetResponse<{ id: string }>>('PushSubscription/set', {
    create: {
      p0: {
        deviceClientId: deviceClientId(),
        url: sub.endpoint,
        keys: { p256dh: b64url(p256dh), auth: b64url(auth) },
      },
    },
  })
  await b.send()
  if (!create.result.created?.['p0']) {
    const err = create.result.notCreated?.['p0']
    throw new Error(err?.description ?? err?.type ?? 'PushSubscription rejected')
  }

  const { id, code } = await verification
  const b2 = new Batch(transport, [Cap.core])
  const upd = b2.call<SetResponse<unknown>>('PushSubscription/set', {
    update: { [id]: { verificationCode: code } },
  })
  await b2.send()
  const err = upd.result.notUpdated?.[id]
  if (err) throw new Error(err.description ?? err.type)
}

export async function disableWebPush(accountId: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  try {
    const { transport } = await transportFor(accountId)
    const b = new Batch(transport, [Cap.core])
    const get = b.call<GetResponse<{ id: string; deviceClientId: string }>>(
      'PushSubscription/get',
      { ids: null },
    )
    await b.send()
    const mine = get.result.list.filter((s) => s.deviceClientId === deviceClientId())
    if (mine.length) {
      const b2 = new Batch(transport, [Cap.core])
      b2.call('PushSubscription/set', { destroy: mine.map((s) => s.id) })
      await b2.send()
    }
  } finally {
    await sub?.unsubscribe()
  }
}
