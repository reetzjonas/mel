import { Batch } from '../providers/jmap/client/request'
import { createTransport } from '../providers/jmap/client/transport'
import { fetchSession } from '../providers/jmap/client/session'
import { Cap, type GetResponse, type SetResponse } from '../providers/jmap/client/types/core'
import { db } from '../storage/db'
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

/*
 * The one change a push is for: mail arriving. `EmailDelivery` (RFC 8621
 * §1.5) moves only on delivery, where `Email` moves on every flag, move and
 * draft save — on any device. Subscribed to everything, archiving on the
 * desktop woke the phone into a "New mail" with nothing new behind it. And a
 * push the worker let pass without a notification is not free either: the
 * browser shows its own "updated in the background" for it instead.
 */
export const PUSH_TYPES = ['EmailDelivery']

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
    { applicationServerKey: string } | undefined
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
        types: PUSH_TYPES,
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

/**
 * Narrows this device's subscription to `PUSH_TYPES` where it was made before
 * it asked for them (`types: null`, everything). Run on start; a subscription
 * that already asks for the right types costs one `get` and nothing more.
 */
export async function narrowPushSubscription(accountId: string): Promise<void> {
  if (!(await isSubscribed())) return
  const { transport } = await transportFor(accountId)
  const b = new Batch(transport, [Cap.core])
  const get = b.call<GetResponse<{ id: string; deviceClientId: string; types?: string[] | null }>>(
    'PushSubscription/get',
    { ids: null },
  )
  await b.send()
  const stale = get.result.list.filter(
    (s) => s.deviceClientId === deviceClientId() && (s.types ?? []).join() !== PUSH_TYPES.join(),
  )
  if (!stale.length) return
  const b2 = new Batch(transport, [Cap.core])
  b2.call('PushSubscription/set', {
    update: Object.fromEntries(stale.map((s) => [s.id, { types: PUSH_TYPES }])),
  })
  await b2.send()
}

/**
 * Whether push notifications may name the sender and subject.
 *
 * Off for an encrypted account whatever the stored flag says: the service
 * worker would have to reach the account's credentials to fetch the message,
 * and those sit behind the passphrase, which only the unlocked main thread
 * holds. Reading it as "off" rather than trusting the flag keeps one answer
 * for the UI and the service worker even if the two ever drift.
 */
export async function pushDetailsEnabled(accountId: string): Promise<boolean> {
  const row = await db.accounts.get(accountId)
  return Boolean(row && !row.encrypted && row.pushDetails)
}

export async function setPushDetails(accountId: string, on: boolean): Promise<void> {
  const row = await db.accounts.get(accountId)
  if (!row) return
  await db.accounts.put({ ...row, pushDetails: on && !row.encrypted })
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
