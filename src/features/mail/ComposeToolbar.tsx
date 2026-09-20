import type { Editor } from '@tiptap/react'
import { useState } from 'react'
import { t } from '../../lib/i18n'
import { Icon, type IconName } from '../../ui/Icon'
import { NameDialog } from '../../ui/NameDialog'
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
        // The editor is the keyboard surface; reaching each formatting command
        // with Tab would put nine stops between the message fields and body.
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()} // keep the editor selection while clicking
        onClick={onClick}
        className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40 sm:min-h-0 sm:min-w-0 ${
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

function setLink(editor: Editor, url: string) {
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
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  if (!editor) return null

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line py-1.5"
        data-horizontal-scroll="editor"
        role="toolbar"
      >
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
            onClick={() =>
              setLinkUrl((editor.getAttributes('link')['href'] as string | undefined) ?? 'https://')
            }
          />
        )}
      </div>
      {linkUrl !== null && (
        <NameDialog
          title={t('compose.link')}
          initial={linkUrl}
          inputType="url"
          confirmLabel={t('folder.save')}
          cancelLabel={t('folder.cancel')}
          onClose={() => setLinkUrl(null)}
          onConfirm={(url) => {
            setLink(editor, url)
            setLinkUrl(null)
          }}
        />
      )}
    </>
  )
}
