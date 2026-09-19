import type { FileNode } from '../../domain/file'
import type { FilesProvider, NewFile, NodeEdit, SetFailure } from '../types'
import { Batch } from './client/request'
import type { Transport } from './client/transport'
import {
  Cap,
  type GetResponse,
  type QueryResponse,
  type SetError,
  type SetResponse,
} from './client/types/core'
import { syncCollection } from './collectionSync'
import { toFileNode, type JmapFileNode } from './mappers/files'

const USING = [Cap.core, Cap.filenode]

const PERMANENT = new Set([
  'invalidProperties',
  'invalidPatch',
  'notFound',
  'forbidden',
  'overQuota',
  'alreadyExists',
  'nodeHasChildren',
])

function toFailure(e: SetError | undefined): SetFailure {
  return {
    type: e?.type ?? 'serverFail',
    description: e?.description,
    permanent: e ? PERMANENT.has(e.type) : false,
  }
}

export function createJmapFiles(
  transport: Transport,
  accountId: string,
  uploadUrl: string,
  downloadUrl: string,
): FilesProvider {
  const batch = () => new Batch(transport, USING)

  async function upload(data: Blob | ArrayBuffer, type: string): Promise<string> {
    const url = uploadUrl.replace('{accountId}', encodeURIComponent(accountId))
    const res = await transport.fetchRaw(url, {
      method: 'POST',
      headers: { 'Content-Type': type || 'application/octet-stream' },
      body: data,
    })
    const j = (await res.json()) as { blobId: string }
    return j.blobId
  }

  const urlFor = (blobId: string, type: string, name: string) =>
    downloadUrl
      .replace('{accountId}', encodeURIComponent(accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{type}', encodeURIComponent(type))
      .replace('{name}', encodeURIComponent(name))

  const readBlob = async (blobId: string, type: string, name: string): Promise<Blob> => {
    const res = await transport.fetchRaw(urlFor(blobId, type, name))
    return res.blob()
  }

  return {
    syncNodes(sinceState) {
      return syncCollection<JmapFileNode, FileNode>(
        batch,
        { type: 'FileNode', accountId, map: toFileNode },
        sinceState,
      )
    },

    async listChildren(parentId: string | null): Promise<FileNode[]> {
      const b = batch()
      // A top-level listing filters on isTopLevel; `parentId: null` is not the
      // same thing and the server does not accept it.
      const q = b.call<QueryResponse>('FileNode/query', {
        accountId,
        filter: parentId === null ? { isTopLevel: true } : { parentId },
      })
      const g = b.call<GetResponse<JmapFileNode>>('FileNode/get', {
        accountId,
        '#ids': q.ref('/ids'),
      })
      await b.send()
      return g.result.list.map(toFileNode)
    },

    async createDirectory(name, parentId) {
      const b = batch()
      const s = b.call<SetResponse<{ id: string }>>('FileNode/set', {
        accountId,
        create: { d0: { name, parentId, nodeType: 'directory' } },
      })
      await b.send()
      const created = s.result.created?.['d0']
      if (created) return { id: created.id, failure: null }
      return { id: null, failure: toFailure(s.result.notCreated?.['d0']) }
    },

    async createFile(file: NewFile) {
      const blobId = await upload(file.data, file.type)
      const b = batch()
      const s = b.call<SetResponse<{ id: string }>>('FileNode/set', {
        accountId,
        create: {
          f0: {
            name: file.name,
            parentId: file.parentId,
            nodeType: 'file',
            blobId,
            type: file.type,
          },
        },
      })
      await b.send()
      const created = s.result.created?.['f0']
      if (created) return { id: created.id, failure: null }
      return { id: null, failure: toFailure(s.result.notCreated?.['f0']) }
    },

    async writeFileContent(id, data, type) {
      const blobId = await upload(data, type)
      const b = batch()
      const s = b.call<SetResponse<unknown>>('FileNode/set', {
        accountId,
        update: { [id]: { blobId, type } },
      })
      await b.send()
      const err = s.result.notUpdated?.[id]
      return err ? toFailure(err) : null
    },

    async editNode(id: string, edit: NodeEdit) {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('FileNode/set', {
        accountId,
        update: { [id]: { ...edit } },
      })
      await b.send()
      const err = s.result.notUpdated?.[id]
      return err ? toFailure(err) : null
    },

    /**
     * Destroy nodes, which the server takes strictly one level at a time.
     *
     * A parent and its child in the same call fails *both* — the child is
     * refused as willDestroy and the parent as nodeHasChildren — so a caller
     * removing a subtree has to work leaf-first across separate calls. This
     * takes ids as given; it is not a recursive delete.
     */
    async destroyNodes(ids: string[]) {
      const b = batch()
      const s = b.call<SetResponse<unknown>>('FileNode/set', { accountId, destroy: ids })
      await b.send()
      const errs = Object.values(s.result.notDestroyed ?? {})
      return errs.length ? toFailure(errs[0]) : null
    },

    async readFile(node: FileNode): Promise<Blob | null> {
      if (!node.blobId) return null
      return readBlob(node.blobId, node.type ?? 'application/octet-stream', node.name)
    },

    readBlob,

    downloadHref(node: FileNode): string | null {
      return node.blobId
        ? urlFor(node.blobId, node.type ?? 'application/octet-stream', node.name)
        : null
    },
  }
}
