import { argon2id } from 'hash-wasm'

export interface KdfSpec {
  algo: 'argon2id' | 'pbkdf2'
  salt: Uint8Array
  params: Record<string, number>
}

export const ARGON2_DEFAULTS = { memoryKiB: 65536, iterations: 3, parallelism: 1 }
export const PBKDF2_DEFAULTS = { iterations: 600_000 }

export function newKdfSpec(preferArgon = true): KdfSpec {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return preferArgon
    ? { algo: 'argon2id', salt, params: { ...ARGON2_DEFAULTS } }
    : { algo: 'pbkdf2', salt, params: { ...PBKDF2_DEFAULTS } }
}

/** Derive the 256-bit key-encryption key (raw bytes) from the passphrase. */
export async function deriveKek(passphrase: string, spec: KdfSpec): Promise<Uint8Array> {
  let raw: Uint8Array
  if (spec.algo === 'argon2id') {
    try {
      raw = await argon2id({
        password: passphrase,
        salt: spec.salt,
        memorySize: spec.params['memoryKiB'] ?? ARGON2_DEFAULTS.memoryKiB,
        iterations: spec.params['iterations'] ?? ARGON2_DEFAULTS.iterations,
        parallelism: spec.params['parallelism'] ?? ARGON2_DEFAULTS.parallelism,
        hashLength: 32,
        outputType: 'binary',
      })
    } catch {
      throw new Error('Argon2id (WASM) unavailable')
    }
  } else {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: spec.salt as BufferSource,
        iterations: spec.params['iterations'] ?? PBKDF2_DEFAULTS.iterations,
      },
      material,
      256,
    )
    raw = new Uint8Array(bits)
  }
  return raw
}
