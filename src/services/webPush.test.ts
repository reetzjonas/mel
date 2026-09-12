import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../providers/jmap/client/transport'
import type { Invocation, JmapRequest } from '../providers/jmap/client/types/core'

/** What each method call is answered with; an array answers repeats in turn. */
let answers: Record<string, unknown> = {}
/** Every call that went over the wire, in order. */
let sent: Array<[string, Record<string, unknown>]> = []
/** Run when a named call is about to be answered — the push pipe replies here. */
let onCall: (name: string) => void = () => {}

/** How many times each method has been answered, so an array advances. */
let taken: Record<string, number> = {}

const answering = (req: JmapRequest) => {
  const methodResponses = req.methodCalls.map(([name, args, id]: Invocation) => {
    sent.push([name, args])
    onCall(name)
    const a = answers[name]
    const value = Array.isArray(a) ? a[(taken[name] = (taken[name] ?? 0) + 1) - 1] : a
    return [name, (value ?? {}) as never, id] as Invocation
  })
  return Promise.resolve({ methodResponses, sessionState: 's' })
}

const transport = { fetchRaw: vi.fn(), request: answering } as unknown as Transport

/** The capabilities the server reports; VAPID is what push hangs off. */
let vapidKey: string | null = 'BServerKey'
let serverCapabilities = { webPush: true }

vi.mock('../providers/jmap/client/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jmap/client/transport')>()),
  createTransport: () => transport,
}))
vi.mock('../providers/jmap/client/session', () => ({
  fetchSession: () =>
    Promise.resolve({
      apiUrl: 'https://jmap.test/api',
      session: {
        capabilities: vapidKey
          ? { 'urn:ietf:params:jmap:webpush-vapid': { applicationServerKey: vapidKey } }
          : {},
      },
    }),
}))
vi.mock('../sync/connections', () => ({
  storedAccount: () =>
    Promise.resolve({
      account: { sessionUrl: 'https://jmap.test/.well-known/jmap' },
      credentials: { method: 'basic', username: 'a', secret: 'b' },
    }),
  connectionFor: () => Promise.resolve({ capabilities: serverCapabilities }),
}))

const { disableWebPush, enableWebPush, isSubscribed, webPushSupported } = await import('./webPush')

/*
 * Two bytes whose standard base64 is "+/8=" — both substituted characters and
 * the padding, so a key that was not converted to base64url is visible.
 */
const KEY_BYTES = new Uint8Array([0xfb, 0xff]).buffer

let subscription: {
  endpoint: string
  getKey: (name: string) => ArrayBuffer | null
  unsubscribe: ReturnType<typeof vi.fn>
} | null

const subscribe = vi.fn(() => Promise.resolve(subscription))
const getSubscription = vi.fn(() => Promise.resolve(subscription))

/** Answer a PushVerification down the pipe the service worker broadcasts on. */
function pushVerification(id: string, code: string) {
  const bc = new BroadcastChannel('mel-push')
  bc.postMessage({ type: 'PushVerification', pushSubscriptionId: id, verificationCode: code })
  bc.close()
}

beforeEach(() => {
  answers = {}
  sent = []
  taken = {}
  onCall = () => {}
  transport.request = answering
  vapidKey = 'BServerKey'
  serverCapabilities = { webPush: true }
  localStorage.clear()
  subscription = {
    endpoint: 'https://push.test/abc',
    getKey: () => KEY_BYTES,
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  }
  subscribe.mockClear()
  const registration = { pushManager: { subscribe, getSubscription } }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      getRegistration: () => Promise.resolve(registration),
    },
  })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
})

afterEach(() => {
  // Delete rather than set to undefined: `'PushManager' in window` asks whether
  // the key exists, which a browser without push support answers with no.
  Reflect.deleteProperty(navigator, 'serviceWorker')
  Reflect.deleteProperty(window, 'PushManager')
})

describe('whether push can be offered at all', () => {
  it('needs both halves: a browser that can and a server that will', async () => {
    await expect(webPushSupported('acc')).resolves.toBe(true)

    serverCapabilities = { webPush: false }
    await expect(webPushSupported('acc')).resolves.toBe(false)

    serverCapabilities = { webPush: true }
    Reflect.deleteProperty(window, 'PushManager')
    await expect(webPushSupported('acc')).resolves.toBe(false)
  })

  it('says no rather than throwing where there is no service worker', async () => {
    // Safari in a private window, or any non-secure context. The settings
    // screen asks this before drawing the toggle.
    Reflect.deleteProperty(navigator, 'serviceWorker')

    await expect(webPushSupported('acc')).resolves.toBe(false)
    await expect(isSubscribed()).resolves.toBe(false)
  })

  it('reports an existing subscription for this device', async () => {
    await expect(isSubscribed()).resolves.toBe(true)

    subscription = null
    await expect(isSubscribed()).resolves.toBe(false)
  })
})

describe('turning push on', () => {
  it('refuses before subscribing when the server has no VAPID key', async () => {
    /*
     * Without RFC 9749 the JMAP server cannot be the application server, so
     * there is nobody to post to the endpoint. Subscribing first would leave a
     * live browser subscription nothing will ever use.
     */
    vapidKey = null

    await expect(enableWebPush('acc')).rejects.toThrow(/VAPID/)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('registers the endpoint with its keys in base64url', async () => {
    // JMAP carries these as JSON strings in a URL-safe alphabet; standard
    // base64 with + / and = is rejected, and the server then cannot encrypt.
    answers = { 'PushSubscription/set': { created: { p0: { id: 'ps-1' } } } }
    onCall = (name) => name === 'PushSubscription/set' && pushVerification('ps-1', 'code-1')

    await enableWebPush('acc')

    const create = sent[0]![1]['create'] as Record<string, Record<string, unknown>>
    expect(create['p0']).toMatchObject({
      url: 'https://push.test/abc',
      keys: { p256dh: '-_8', auth: '-_8' },
    })
  })

  it('is listening before it asks, because the code may arrive first', async () => {
    /*
     * The server sends the PushVerification the moment the subscription is
     * created — down the push pipe, which can outrun the JMAP response.
     * Subscribing to the broadcast only after the create call returns loses
     * it, and the subscription then stays unverified for ever.
     */
    answers = { 'PushSubscription/set': [{ created: { p0: { id: 'ps-1' } } }, {}] }
    onCall = (name) => name === 'PushSubscription/set' && pushVerification('ps-1', 'code-1')

    await enableWebPush('acc')

    expect(sent.map(([name]) => name)).toEqual(['PushSubscription/set', 'PushSubscription/set'])
    expect(sent[1]![1]['update']).toEqual({ 'ps-1': { verificationCode: 'code-1' } })
  })

  it('ignores anything on that channel that is not a verification', async () => {
    // The service worker broadcasts other things too; taking the first message
    // as the code would send the server nonsense.
    answers = { 'PushSubscription/set': [{ created: { p0: { id: 'ps-1' } } }, {}] }
    onCall = (name) => {
      if (name !== 'PushSubscription/set') return
      const bc = new BroadcastChannel('mel-push')
      bc.postMessage({ type: 'StateChange', changed: {} })
      bc.postMessage({ type: 'PushVerification', pushSubscriptionId: 'ps-1' })
      bc.close()
      pushVerification('ps-1', 'code-1')
    }

    await enableWebPush('acc')

    expect(sent[1]![1]['update']).toEqual({ 'ps-1': { verificationCode: 'code-1' } })
  })

  it('raises what the server said when it refused the subscription', async () => {
    answers = {
      'PushSubscription/set': { notCreated: { p0: { type: 'forbidden', description: 'no push' } } },
    }

    await expect(enableWebPush('acc')).rejects.toThrow('no push')
  })

  it('raises a refused verification rather than reporting push as on', async () => {
    answers = {
      'PushSubscription/set': [
        { created: { p0: { id: 'ps-1' } } },
        { notUpdated: { 'ps-1': { type: 'invalidProperties', description: 'wrong code' } } },
      ],
    }
    onCall = (name) => name === 'PushSubscription/set' && pushVerification('ps-1', 'code-1')

    await expect(enableWebPush('acc')).rejects.toThrow('wrong code')
  })

  it('refuses a subscription the browser gave without encryption keys', async () => {
    // Nothing could be delivered through it; the server needs both keys to
    // encrypt the payload.
    subscription = {
      endpoint: 'https://push.test/abc',
      getKey: () => null,
      unsubscribe: vi.fn(),
    }

    await expect(enableWebPush('acc')).rejects.toThrow(/encryption keys/)
  })

  it('keeps the same device id across subscriptions', async () => {
    /*
     * The id is how "this device" is recognised on the server, and how turning
     * push off again finds what to delete. A fresh one per subscribe would
     * orphan a subscription on every reload.
     */
    answers = { 'PushSubscription/set': [{ created: { p0: { id: 'ps-1' } } }, {}] }
    onCall = (name) => name === 'PushSubscription/set' && pushVerification('ps-1', 'code-1')
    await enableWebPush('acc')
    const first = (sent[0]![1]['create'] as Record<string, Record<string, unknown>>)['p0']!

    sent = []
    taken = {}
    answers = { 'PushSubscription/set': [{ created: { p0: { id: 'ps-2' } } }, {}] }
    onCall = (name) => name === 'PushSubscription/set' && pushVerification('ps-2', 'code-2')
    await enableWebPush('acc')
    const second = (sent[0]![1]['create'] as Record<string, Record<string, unknown>>)['p0']!

    expect(second['deviceClientId']).toBe(first['deviceClientId'])
  })
})

describe('turning push off', () => {
  it('destroys only the subscriptions belonging to this device', async () => {
    // The same account may be signed in on a phone as well, and that one has
    // to keep receiving.
    answers = { 'PushSubscription/set': [{ created: { p0: { id: 'ps-1' } } }, {}] }
    onCall = (name) => name === 'PushSubscription/set' && pushVerification('ps-1', 'code-1')
    await enableWebPush('acc')
    const mine = (
      (sent[0]![1]['create'] as Record<string, Record<string, unknown>>)['p0'] as Record<
        string,
        unknown
      >
    )['deviceClientId'] as string

    sent = []
    taken = {}
    onCall = () => {}
    answers = {
      'PushSubscription/get': {
        list: [
          { id: 'ps-1', deviceClientId: mine },
          { id: 'ps-phone', deviceClientId: 'another-device' },
        ],
      },
    }

    await disableWebPush('acc')

    expect(sent[1]![1]['destroy']).toEqual(['ps-1'])
  })

  it('asks the server for nothing when this device has none there', async () => {
    answers = { 'PushSubscription/get': { list: [{ id: 'x', deviceClientId: 'someone-else' }] } }

    await disableWebPush('acc')

    expect(sent.map(([name]) => name)).toEqual(['PushSubscription/get'])
  })

  it('unsubscribes the browser even when the server call fails', async () => {
    /*
     * Otherwise a server that is unreachable leaves push switched on locally
     * with the toggle showing off — notifications keep arriving and nothing in
     * the UI explains why.
     */
    const failing = subscription!
    transport.request = () => Promise.reject(new Error('offline'))

    await expect(disableWebPush('acc')).rejects.toThrow('offline')

    expect(failing.unsubscribe).toHaveBeenCalled()
  })
})
