import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUi } from '../app/store'
import type { FileNode } from '../domain/file'
import { db } from '../storage/db'
import { sealPlain } from '../storage/envelope'

// A real `enqueue` schedules a flush via setTimeout, which would go on to
// call connectionFor() against an account that does not exist here — same
// mock services/notes.test.ts already uses for the same reason.
vi.mock('./outbox', () => ({
  enqueue: (accountId: string, action: { kind: string }) =>
    db.outbox.add({
      accountId,
      kind: action.kind,
      status: 'pending',
      attempts: 0,
      notBefore: 0,
      payload: sealPlain(action),
    }),
}))

const { getState, putState } = await import('./engine')
const { reconcileSettings } = await import('./settings')
const { MEL_FOLDER, SETTINGS_FILE } = await import('./settingsWriter')

const ACC = 'acc-settings-reconcile'

const node = (over: Partial<FileNode> & { id: string; name: string }): FileNode => ({
  parentId: null,
  nodeType: 'directory',
  blobId: null,
  type: null,
  size: null,
  target: null,
  executable: false,
  created: '2026-01-01T00:00:00Z',
  modified: '2026-01-01T00:00:00Z',
  ...over,
})

async function putFileRow(n: FileNode) {
  await db.files.put({
    accountId: ACC,
    id: n.id,
    parentKey: n.parentId ?? '',
    nodeType: n.nodeType,
    payload: sealPlain(n),
  })
}

/** Account/.mel/settings.json, populated into the local file-tree mirror. */
async function putSettingsTree(fileModified = '2026-01-01T00:00:00Z') {
  await putFileRow(node({ id: 'root', name: MEL_FOLDER }))
  await putFileRow(
    node({
      id: 'f1',
      name: SETTINGS_FILE,
      parentId: 'root',
      nodeType: 'file',
      modified: fileModified,
    }),
  )
}

let read: string[] = []
let content = '{"version":1,"theme":"dark"}'

const files = {
  readFile: (n: FileNode) => {
    read.push(n.id)
    return Promise.resolve(new Blob([content]))
  },
} as never

beforeEach(async () => {
  await db.files.clear()
  await db.syncState.clear()
  await db.outbox.clear()
  localStorage.clear()
  read = []
  content = '{"version":1,"theme":"dark"}'
})

describe('no .mel/settings.json on the server yet', () => {
  it('pushes the local settings up instead of reading anything', async () => {
    await reconcileSettings(ACC, files)

    expect(read).toEqual([])
    const pending = await db.outbox.where('accountId').equals(ACC).toArray()
    expect(pending.map((r) => r.kind)).toEqual(['settings.save'])
  })

  it('does not queue a second push while one is already pending', async () => {
    await reconcileSettings(ACC, files)
    await reconcileSettings(ACC, files)

    const pending = await db.outbox.where('accountId').equals(ACC).toArray()
    expect(pending).toHaveLength(1)
  })
})

describe('a settings.json the account has not applied before', () => {
  it('reads it and applies it', async () => {
    await putSettingsTree()

    await reconcileSettings(ACC, files)

    expect(read).toEqual(['f1'])
    expect(localStorage.getItem('mel:theme')).toBe('dark')
  })

  it('records the marker so it is not read again unchanged', async () => {
    await putSettingsTree()
    await reconcileSettings(ACC, files)

    await reconcileSettings(ACC, files)

    expect(read).toEqual(['f1']) // once, not twice
  })
})

describe('a settings.json already applied', () => {
  it('does not re-read it', async () => {
    await putSettingsTree('2026-01-01T00:00:00Z')
    await putState(ACC, 'Settings', '2026-01-01T00:00:00Z')

    await reconcileSettings(ACC, files)

    expect(read).toEqual([])
  })

  it('reads it again once the file moves on', async () => {
    await putSettingsTree('2026-02-01T00:00:00Z')
    await putState(ACC, 'Settings', '2026-01-01T00:00:00Z')

    await reconcileSettings(ACC, files)

    expect(read).toEqual(['f1'])
    expect(await getState(ACC, 'Settings')).toBe('2026-02-01T00:00:00Z')
  })
})

describe('the file cannot be read right now', () => {
  it('leaves the marker alone rather than accepting a state never actually read', async () => {
    await putSettingsTree()
    const unreadable = { readFile: () => Promise.resolve(null) } as never

    await reconcileSettings(ACC, unreadable)

    expect(await getState(ACC, 'Settings')).toBeUndefined()
  })
})

describe('a field with a push of its own already queued', () => {
  async function queueThemeSave(status: 'pending' | 'inflight') {
    await db.outbox.add({
      accountId: ACC,
      kind: 'settings.save',
      status,
      attempts: 0,
      notBefore: 0,
      payload: sealPlain({ kind: 'settings.save', fields: ['theme'] }),
    })
  }

  it('is not overwritten by the pull, so the pull cannot undo it before it sends', async () => {
    await putSettingsTree()
    content = '{"version":1,"theme":"dark","conversationView":false}'
    await queueThemeSave('pending')
    localStorage.setItem('mel:theme', 'light') // this device's own not-yet-sent edit

    await reconcileSettings(ACC, files)

    expect(localStorage.getItem('mel:theme')).toBe('light')
    // A field with nothing queued still applies normally.
    expect(useUi.getState().conversationView).toBe(false)
  })

  it('protects a push that is already inflight, not only a pending one', async () => {
    await putSettingsTree()
    content = '{"version":1,"theme":"dark"}'
    await queueThemeSave('inflight')
    localStorage.setItem('mel:theme', 'light')

    await reconcileSettings(ACC, files)

    expect(localStorage.getItem('mel:theme')).toBe('light')
  })

  it('does not protect a field a failed push gave up on', async () => {
    await putSettingsTree()
    content = '{"version":1,"theme":"dark"}'
    await queueThemeSave('pending')
    await db.outbox
      .where('accountId')
      .equals(ACC)
      .modify({ status: 'failed' })
    localStorage.setItem('mel:theme', 'light')

    await reconcileSettings(ACC, files)

    expect(localStorage.getItem('mel:theme')).toBe('dark')
  })
})

describe('malformed content on the server', () => {
  it('is treated as empty rather than thrown', async () => {
    await putSettingsTree()
    content = 'not json {{{'

    await expect(reconcileSettings(ACC, files)).resolves.toBeUndefined()
    expect(await getState(ACC, 'Settings')).toBe('2026-01-01T00:00:00Z')
  })

  it('treats valid JSON that is not an object the same way', async () => {
    await putSettingsTree()
    content = '[1,2,3]'

    await expect(reconcileSettings(ACC, files)).resolves.toBeUndefined()
    expect(await getState(ACC, 'Settings')).toBe('2026-01-01T00:00:00Z')
  })
})
