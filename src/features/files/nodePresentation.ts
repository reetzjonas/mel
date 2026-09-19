import type { FileNode, FileNodeRole } from '../../domain/file'
import { t, type MsgKey } from '../../lib/i18n'
import type { IconName } from '../../ui/Icon'

export function nodeLabel(node: FileNode): string {
  const labels: Record<NonNullable<FileNodeRole>, MsgKey> = {
    root: 'files.root',
    home: 'files.role.home',
    temp: 'files.role.temp',
    trash: 'files.role.trash',
    documents: 'files.role.documents',
    downloads: 'files.role.downloads',
    music: 'files.role.music',
    pictures: 'files.role.pictures',
    videos: 'files.role.videos',
  }
  return node.parentId === null && node.role ? t(labels[node.role]) : node.name
}

export function nodeIcon(node: FileNode): IconName {
  if (node.nodeType !== 'directory') return node.nodeType === 'symlink' ? 'link' : 'file'
  if (node.parentId !== null) return 'folder'
  const icons: Record<NonNullable<FileNodeRole>, IconName> = {
    root: 'folder',
    home: 'home',
    temp: 'folder',
    trash: 'trash',
    documents: 'file',
    downloads: 'download',
    music: 'music',
    pictures: 'image',
    videos: 'video',
  }
  return icons[node.role ?? 'root']
}
