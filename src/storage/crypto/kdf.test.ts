import { describe, expect, it } from 'vitest'
import { ARGON2_DEFAULTS, PBKDF2_DEFAULTS, deriveKek, newKdfSpec, type KdfSpec } from './kdf'

const salt = (fill: number) => new Uint8Array(16).fill(fill)

/** Deliberately weak, so a test finishes: the count is read off the spec. */
const cheapPbkdf2 = (over: Partial<KdfSpec> = {}): KdfSpec => ({
  algo: 'pbkdf2',
  salt: salt(1),
  params: { iterations: 1_000 },
  ...over,
})

describe('newKdfSpec', () => {
  it('draws a fresh salt every time', () => {
    // Two keyrings sharing a salt is the one thing a salt exists to prevent:
    // a table built for one passphrase would then work against the other.
    const a = newKdfSpec()
    const b = newKdfSpec()
    expect(a.salt).toHaveLength(16)
    expect([...a.salt]).not.toEqual([...b.salt])
  })

  it('prefers Argon2id, and can be asked for PBKDF2 instead', () => {
    expect(newKdfSpec()).toMatchObject({ algo: 'argon2id', params: ARGON2_DEFAULTS })
    expect(newKdfSpec(false)).toMatchObject({ algo: 'pbkdf2', params: PBKDF2_DEFAULTS })
  })

  it('copies the defaults rather than handing out the shared object', () => {
    // A spec is stored per account; mutating one must not retune every other
    // account's key derivation.
    const spec = newKdfSpec()
    spec.params['iterations'] = 1
    expect(ARGON2_DEFAULTS.iterations).not.toBe(1)
  })
})

describe('deriveKek', () => {
  it('returns the same 256-bit key for the same passphrase and spec', async () => {
    // The whole scheme rests on this: a key that differed between runs would
    // lock the account out of its own data.
    const spec = cheapPbkdf2()
    const first = await deriveKek('korrekt-pferd', spec)
    const second = await deriveKek('korrekt-pferd', spec)

    expect(first).toHaveLength(32)
    expect([...first]).toEqual([...second])
  })

  it('gives a different key for a different passphrase', async () => {
    const spec = cheapPbkdf2()
    const right = await deriveKek('korrekt-pferd', spec)
    const wrong = await deriveKek('korrekt-pferdd', spec)
    expect([...right]).not.toEqual([...wrong])
  })

  it('gives a different key under a different salt', async () => {
    const a = await deriveKek('korrekt-pferd', cheapPbkdf2())
    const b = await deriveKek('korrekt-pferd', cheapPbkdf2({ salt: salt(2) }))
    expect([...a]).not.toEqual([...b])
  })

  it('takes its cost from the stored spec, not from today’s defaults', async () => {
    /*
     * This is what lets the defaults be raised later. Deriving with the
     * current constants instead of the ones the keyring was written with
     * would produce a different key for every existing account — every one
     * of them locked out by a change meant to protect them.
     */
    const weak = await deriveKek('korrekt-pferd', cheapPbkdf2({ params: { iterations: 1_000 } }))
    const stronger = await deriveKek(
      'korrekt-pferd',
      cheapPbkdf2({ params: { iterations: 2_000 } }),
    )
    expect([...weak]).not.toEqual([...stronger])
  })

  it('derives through Argon2id as well, with the same guarantees', async () => {
    // Cheap parameters on purpose; the point is the branch, not the cost.
    const spec: KdfSpec = {
      algo: 'argon2id',
      salt: salt(3),
      params: { memoryKiB: 256, iterations: 1, parallelism: 1 },
    }
    const first = await deriveKek('korrekt-pferd', spec)
    const second = await deriveKek('korrekt-pferd', spec)
    const other = await deriveKek('anderes', spec)

    expect(first).toHaveLength(32)
    expect([...first]).toEqual([...second])
    expect([...first]).not.toEqual([...other])
  })

  it('is not the same key under both algorithms', async () => {
    // Same passphrase, same salt: the algorithm has to be part of what the
    // key depends on, or a spec downgraded in storage would still unlock.
    const common = salt(4)
    const argon = await deriveKek('korrekt-pferd', {
      algo: 'argon2id',
      salt: common,
      params: { memoryKiB: 256, iterations: 1, parallelism: 1 },
    })
    const pbkdf2 = await deriveKek('korrekt-pferd', cheapPbkdf2({ salt: common }))
    expect([...argon]).not.toEqual([...pbkdf2])
  })
})
