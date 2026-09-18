import { beforeEach, describe, expect, it } from 'vitest'
import type { FileNode } from '../domain/file'
import { ALL_SYNCED_FIELDS } from '../services/settings'
import { saveSettingsFile, MEL_FOLDER, SETTINGS_FILE } from './settingsWriter'

const ACC = 'acc-settings-writer'

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

let children: Record<string, FileNode[]> = {}
let created: Array<{ name: string; parentId: string | null }> = []
let written: Array<{ id: string; text: string }> = []
let serverContent: string | null = null
let nextId = 0

const files = {
  listChildren: (parentId: string | null) => Promise.resolve(children[parentId ?? 'root'] ?? []),
  createDirectory: (name: string, parentId: string | null) => {
    created.push({ name, parentId })
    return Promise.resolve({ id: `dir-${++nextId}`, failure: null })
  },
  createFile: async (f: { name: string; parentId: string | null; data: Blob | ArrayBuffer }) => {
    created.push({ name: f.name, parentId: f.parentId })
    if (f.data instanceof Blob) written.push({ id: `file-${nextId}`, text: await f.data.text() })
    return { id: `file-${++nextId}`, failure: null }
  },
  writeFileContent: async (id: string, data: Blob) => {
    written.push({ id, text: await data.text() })
    return null
  },
  readFile: () => Promise.resolve(serverContent === null ? null : new Blob([serverContent])),
} as never

beforeEach(() => {
  localStorage.clear()
  children = {}
  created = []
  written = []
  serverContent = null
  nextId = 0
})

describe('writing settings for the first time', () => {
  it('makes the .mel folder and the file', async () => {
    await saveSettingsFile(ACC, files, ALL_SYNCED_FIELDS)

    expect(created[0]!.name).toBe(MEL_FOLDER)
    expect(created[1]!.name).toBe(SETTINGS_FILE)
    const written1 = JSON.parse(written[0]!.text)
    expect(written1.version).toBe(1)
    expect(written1.theme).toBe('system')
  })

  it('uses the folder that is already there rather than a second one', async () => {
    children['root'] = [node({ id: 'root-id', name: MEL_FOLDER })]

    await saveSettingsFile(ACC, files, ALL_SYNCED_FIELDS)

    expect(created.map((c) => c.name)).toEqual([SETTINGS_FILE])
  })
})

describe('writing settings that already exist', () => {
  beforeEach(() => {
    children['root'] = [node({ id: 'root-id', name: MEL_FOLDER })]
    children['root-id'] = [
      node({ id: 'f1', name: SETTINGS_FILE, parentId: 'root-id', nodeType: 'file' }),
    ]
  })

  it('replaces the file in place rather than adding another', async () => {
    serverContent = JSON.stringify({ version: 1, theme: 'dark' })

    await saveSettingsFile(ACC, files, ALL_SYNCED_FIELDS)

    expect(created).toEqual([])
    expect(written).toEqual([{ id: 'f1', text: expect.any(String) }])
  })

  it('overwrites a field named in the push', async () => {
    serverContent = JSON.stringify({ version: 1, theme: 'dark' })
    localStorage.setItem('mel:theme', 'light')

    await saveSettingsFile(ACC, files, ['theme'])

    expect(JSON.parse(written[0]!.text).theme).toBe('light')
  })

  it('leaves a known field alone when the push does not name it', async () => {
    // The scoping that keeps two devices changing different settings from
    // stomping each other: a push that only changed the theme must not also
    // overwrite hiddenCalendars with this device's (possibly stale) copy of
    // it, which is exactly what a different device may have just changed.
    serverContent = JSON.stringify({
      version: 1,
      theme: 'dark',
      hiddenCalendars: ['cal-from-another-device'],
    })
    localStorage.setItem('mel:theme', 'light')

    await saveSettingsFile(ACC, files, ['theme'])

    const merged = JSON.parse(written[0]!.text)
    expect(merged.theme).toBe('light')
    expect(merged.hiddenCalendars).toEqual(['cal-from-another-device'])
  })

  it('keeps a top-level key this build does not recognise', async () => {
    // A newer or older mel version's own field — schema evolution must not
    // lose it just because this build never reads it.
    serverContent = JSON.stringify({ version: 1, futureFeature: { on: true } })

    await saveSettingsFile(ACC, files, ALL_SYNCED_FIELDS)

    expect(JSON.parse(written[0]!.text).futureFeature).toEqual({ on: true })
  })

  it('treats an unparseable server file as empty rather than throwing', async () => {
    serverContent = 'not json at all {{{'

    await expect(saveSettingsFile(ACC, files, ALL_SYNCED_FIELDS)).resolves.toBeUndefined()
    const parsed = JSON.parse(written[0]!.text)
    expect(parsed.version).toBe(1)
  })

  it('treats valid JSON that is not an object (an array) the same way', async () => {
    serverContent = '[1,2,3]'

    await expect(saveSettingsFile(ACC, files, ALL_SYNCED_FIELDS)).resolves.toBeUndefined()
    const parsed = JSON.parse(written[0]!.text)
    expect(parsed.version).toBe(1)
    expect(Array.isArray(parsed)).toBe(false)
  })
})

describe('when the server refuses', () => {
  it('throws when the folder could not be made', async () => {
    const refusing = {
      ...(files as object),
      createDirectory: () =>
        Promise.resolve({ id: null, failure: { type: 'overQuota', permanent: false } }),
    } as never

    await expect(saveSettingsFile(ACC, refusing, ALL_SYNCED_FIELDS)).rejects.toThrow('overQuota')
  })

  it('throws when the file could not be created', async () => {
    const refusing = {
      ...(files as object),
      createFile: () =>
        Promise.resolve({ id: null, failure: { type: 'overQuota', permanent: false } }),
    } as never

    await expect(saveSettingsFile(ACC, refusing, ALL_SYNCED_FIELDS)).rejects.toThrow('overQuota')
  })

  it('throws when an existing file could not be replaced, carrying a permanent refusal through as permanent', async () => {
    children['root'] = [node({ id: 'root-id', name: MEL_FOLDER })]
    children['root-id'] = [
      node({ id: 'f1', name: SETTINGS_FILE, parentId: 'root-id', nodeType: 'file' }),
    ]
    const refusing = {
      ...(files as object),
      writeFileContent: () =>
        Promise.resolve({ type: 'forbidden', description: 'Read only', permanent: true }),
    } as never

    await expect(saveSettingsFile(ACC, refusing, ALL_SYNCED_FIELDS)).rejects.toMatchObject({
      permanent: true,
    })
  })
})
