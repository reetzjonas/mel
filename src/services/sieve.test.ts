import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetFailure, SieveScriptEdit } from '../providers/types'

let saveFailure: SetFailure | null = null
let activeFailure: SetFailure | null = null
let destroyFailure: SetFailure | null = null
let hasProvider = true
let saved: SieveScriptEdit[] = []
let activated: Array<string | null> = []

const sieve = {
  listScripts: () => Promise.resolve([{ id: 's1', name: 'filters', blobId: 'b1', isActive: true }]),
  readScript: () => Promise.resolve('require ["fileinto"];'),
  validate: (content: string) =>
    Promise.resolve(content === 'bogus' ? 'Expected token at line 1.' : null),
  saveScript: (edit: SieveScriptEdit) => {
    saved.push(edit)
    return Promise.resolve({ id: saveFailure ? null : 'new', failure: saveFailure })
  },
  setActive: (id: string | null) => {
    activated.push(id)
    return Promise.resolve(activeFailure)
  },
  destroyScript: () => Promise.resolve(destroyFailure),
}

vi.mock('../sync/connections', () => ({
  connectionFor: () => Promise.resolve({ sieve: hasProvider ? sieve : null }),
}))

const { checkScript, deleteScript, listScripts, readScript, saveScript, setActiveScript } =
  await import('./sieve')

beforeEach(() => {
  saveFailure = null
  activeFailure = null
  destroyFailure = null
  hasProvider = true
  saved = []
  activated = []
})

describe('classifying what the server refused', () => {
  it('calls a script the server would not parse a syntax problem', async () => {
    // The server's own message carries the line number, which is the only
    // thing that makes an editor usable — so it is passed through as-is.
    saveFailure = {
      type: 'invalidScript',
      description: 'Expected token at line 1.',
      permanent: true,
    }

    expect(await saveScript('acc', { name: 'x', content: 'bogus' })).toEqual({
      ok: false,
      blocker: 'syntax',
      message: 'Expected token at line 1.',
    })
  })

  it('recognises the refusal to delete the active script under either name', async () => {
    // RFC 9661 registers sieveIsActive; Stalwart says scriptIsActive.
    for (const type of ['sieveIsActive', 'scriptIsActive']) {
      destroyFailure = { type, description: 'Deactivate first.', permanent: true }
      expect((await deleteScript('acc', 's1')).blocker).toBe('active')
    }
  })

  it('leaves anything else as a plain failure', async () => {
    destroyFailure = { type: 'forbidden', permanent: true }

    expect((await deleteScript('acc', 's1')).blocker).toBe('other')
  })

  it('says nothing went wrong when nothing did', async () => {
    expect(await deleteScript('acc', 's1')).toEqual({ ok: true })
  })
})

describe('saving', () => {
  it('passes the activation choice through', async () => {
    await saveScript('acc', { name: 'x', content: 'y', activate: true })

    expect(saved[0]).toMatchObject({ name: 'x', activate: true })
  })
})

describe('activating', () => {
  it('switches filtering off with a null id rather than picking another', async () => {
    await setActiveScript('acc', null)

    expect(activated).toEqual([null])
  })

  it('reports a refusal instead of pretending it worked', async () => {
    activeFailure = { type: 'notFound', permanent: true }

    expect(await setActiveScript('acc', 's1')).toMatchObject({ ok: false, blocker: 'other' })
  })
})

describe('checking a script', () => {
  it('is quiet when it parses', async () => {
    expect(await checkScript('acc', 'require ["fileinto"];')).toBeNull()
  })

  it('hands back what the server objected to', async () => {
    expect(await checkScript('acc', 'bogus')).toBe('Expected token at line 1.')
  })
})

describe('a server without sieve', () => {
  it('has no scripts rather than throwing', async () => {
    hasProvider = false

    expect(await listScripts('acc')).toEqual([])
    expect(await readScript('acc', { id: 's', name: 'n', blobId: 'b', isActive: false })).toBe('')
    expect(await checkScript('acc', 'x')).toBeNull()
  })

  it('refuses a write rather than reporting success', async () => {
    hasProvider = false

    expect(await saveScript('acc', { name: 'x', content: 'y' })).toMatchObject({ ok: false })
    expect(await setActiveScript('acc', null)).toMatchObject({ ok: false })
    expect(await deleteScript('acc', 's1')).toMatchObject({ ok: false })
  })
})
