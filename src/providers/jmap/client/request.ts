import type { Transport } from './transport'
import { JmapError } from './transport'
import type {
  Invocation,
  JmapResponse,
  MethodError,
  ResultReference,
} from './types/core'

/**
 * Typed JMAP batch builder. Collects method calls, supports back-references
 * (`#arg: {resultOf, name, path}`), sends them as one request and hands each
 * caller its own response.
 *
 *   const b = new Batch(transport, [Cap.core, Cap.mail])
 *   const q = b.call('Email/query', { accountId, filter })
 *   const g = b.call('Email/get', { accountId, properties,
 *     '#ids': q.ref('/ids') })
 *   await b.send()
 *   q.result // QueryResponse
 */
export class CallHandle<T = Record<string, unknown>> {
  #result: T | null = null
  #error: MethodError | null = null
  readonly callId: string
  readonly name: string

  constructor(callId: string, name: string) {
    this.callId = callId
    this.name = name
  }

  ref(path: string): ResultReference {
    return { resultOf: this.callId, name: this.name, path }
  }

  /** @internal */
  resolve(responses: Invocation[]) {
    for (const [name, args, callId] of responses) {
      if (callId !== this.callId) continue
      if (name === 'error') {
        this.#error = args as unknown as MethodError
      } else {
        this.#result = args as T
      }
      return
    }
    this.#error = { type: 'serverFail', description: 'no response for call' }
  }

  get result(): T {
    if (this.#error)
      throw new JmapError(
        `${this.name}: ${this.#error.type}${this.#error.description ? ` (${this.#error.description})` : ''}`,
        this.#error.type === 'serverFail' ? 'server' : 'protocol',
      )
    if (this.#result === null) throw new Error(`Batch not sent yet (${this.name})`)
    return this.#result
  }

  get error(): MethodError | null {
    return this.#error
  }
}

export class Batch {
  #calls: Invocation[] = []
  #handles: CallHandle<never>[] = []
  #seq = 0
  readonly #transport: Transport
  readonly #using: string[]

  constructor(transport: Transport, using: string[]) {
    this.#transport = transport
    this.#using = using
  }

  call<T>(name: string, args: Record<string, unknown>): CallHandle<T> {
    const callId = `c${this.#seq++}`
    const handle = new CallHandle<T>(callId, name)
    this.#calls.push([name, args, callId])
    this.#handles.push(handle as CallHandle<never>)
    return handle
  }

  get size(): number {
    return this.#calls.length
  }

  async send(signal?: AbortSignal): Promise<JmapResponse> {
    const response = await this.#transport.request(
      { using: this.#using, methodCalls: this.#calls },
      signal,
    )
    for (const h of this.#handles) h.resolve(response.methodResponses)
    return response
  }
}

/**
 * Split ids into chunks respecting maxObjectsInGet.
 *
 * A size that is not a positive number yields one chunk holding everything
 * rather than an empty one: too large a request is rejected visibly by the
 * server, whereas dropping the ids here loses the caller's work in silence.
 */
export function chunkIds(ids: string[], maxObjects: number): string[][] {
  if (!Number.isFinite(maxObjects) || maxObjects < 1) return [ids]
  if (ids.length <= maxObjects) return [ids]
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += maxObjects) out.push(ids.slice(i, i + maxObjects))
  return out
}
