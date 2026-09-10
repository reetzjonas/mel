import type { Editor } from '@tiptap/react'
import { t } from '../../lib/i18n'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'

function ToolbarButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: IconName
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()} // keep the editor selection while clicking
        onClick={onClick}
        className={`rounded-control p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
          active ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
        }`}
      >
        <Icon name={icon} size={15} />
      </button>
    </Tooltip>
  )
}

/** Vertical divider between button groups, height-matched to the buttons around it. */
function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />
}

function promptForLink(editor: Editor) {
  const previous = editor.getAttributes('link')['href'] as string | undefined
  const url = window.prompt(t('compose.linkPrompt'), previous ?? 'https://')
  if (url === null) return
  const chain = editor.chain().focus().extendMarkRange('link')
  if (url === '') chain.unsetLink().run()
  else chain.setLink({ href: url }).run()
}

/**
 * Formatting toolbar for the compose editor. Reads active-mark state straight
 * off the editor on every render — the caller re-renders it on both content
 * and selection changes (a cursor moving into bold text has to flip the
 * button without any content changing), so there is no state to keep in sync
 * here.
 */
export function ComposeToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line py-1.5" role="toolbar">
      <ToolbarButton
        icon="bold"
        label={t('compose.bold')}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        icon="italic"
        label={t('compose.italic')}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        icon="underline"
        label={t('compose.underline')}
        active={editor.isActive('underline')}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      />
      <ToolbarButton
        icon="strikethrough"
        label={t('compose.strikethrough')}
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <Divider />
      <ToolbarButton
        icon="bulletList"
        label={t('compose.bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        icon="orderedList"
        label={t('compose.orderedList')}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        icon="quote"
        label={t('compose.quote')}
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <Divider />
      {editor.isActive('link') ? (
        <ToolbarButton
          icon="unlink"
          label={t('compose.unlink')}
          active
          onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
        />
      ) : (
        <ToolbarButton
          icon="link"
          label={t('compose.link')}
          onClick={() => promptForLink(editor)}
        />
      )}
    </div>
  )
}
