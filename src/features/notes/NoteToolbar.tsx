import type { EditorView } from '@codemirror/view'
import { t } from '../../lib/i18n'
import { Icon, type IconName } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'
import {
  insertLink,
  toggleLinePrefix,
  toggleTask,
  toggleWrap,
  type MarkdownCommand,
} from './markdownCommands'

function ToolbarButton({
  icon,
  label,
  onClick,
}: {
  icon: IconName
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        // Keeps the selection in the editor while the button is pressed;
        // without it the click takes the focus and "bold" has nothing to act on.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Icon name={icon} size={15} />
      </button>
    </Tooltip>
  )
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden />
}

/**
 * The buttons that write the Markdown so nobody has to remember it.
 *
 * Every one of them is the same command the keyboard shortcut runs, and each
 * writes plain text into the document — pressing bold inserts the asterisks
 * the file would have had anyway. Nothing here knows about the note; it only
 * knows about the editor it was handed.
 */
export function NoteToolbar({ view }: { view: EditorView | null }) {
  const run = (command: MarkdownCommand) => () => {
    if (!view) return
    view.dispatch(command(view.state))
    view.focus()
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1">
      <ToolbarButton
        icon="heading"
        label={t('notes.format.heading')}
        onClick={run((state) => toggleLinePrefix(state, '## '))}
      />
      <ToolbarButton
        icon="bold"
        label={t('notes.format.bold')}
        onClick={run((state) => toggleWrap(state, '**'))}
      />
      <ToolbarButton
        icon="italic"
        label={t('notes.format.italic')}
        onClick={run((state) => toggleWrap(state, '*'))}
      />
      <ToolbarButton
        icon="strikethrough"
        label={t('notes.format.strike')}
        onClick={run((state) => toggleWrap(state, '~~'))}
      />
      <Divider />
      <ToolbarButton
        icon="bulletList"
        label={t('notes.format.list')}
        onClick={run((state) => toggleLinePrefix(state, '- '))}
      />
      <ToolbarButton icon="check" label={t('notes.format.task')} onClick={run(toggleTask)} />
      <ToolbarButton
        icon="quote"
        label={t('notes.format.quote')}
        onClick={run((state) => toggleLinePrefix(state, '> '))}
      />
      <Divider />
      <ToolbarButton
        icon="link"
        label={t('notes.format.link')}
        onClick={run((state) => insertLink(state))}
      />
      <ToolbarButton
        icon="quoteCode"
        label={t('notes.format.code')}
        onClick={run((state) => toggleWrap(state, '`'))}
      />
    </div>
  )
}
