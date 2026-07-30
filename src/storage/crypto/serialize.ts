// JSON serialization that survives ArrayBuffer/Uint8Array payload members
// (blobCache stores raw attachment bytes).

const AB_TAG = '__mel_ab'
const U8_TAG = '__mel_u8'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function serialize(value: unknown): Uint8Array {
  const json = JSON.stringify(value, (_k, v: unknown) => {
    if (v instanceof ArrayBuffer) return { [AB_TAG]: toBase64(new Uint8Array(v)) }
    if (v instanceof Uint8Array) return { [U8_TAG]: toBase64(v) }
    return v
  })
  return new TextEncoder().encode(json)
}

export function deserialize<T>(bytes: Uint8Array): T {
  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o[AB_TAG] === 'string') {
        const u8 = fromBase64(o[AB_TAG])
        // Return a standalone ArrayBuffer of exactly this content.
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
      }
      if (typeof o[U8_TAG] === 'string') return fromBase64(o[U8_TAG])
    }
    return v
  }) as T
}
