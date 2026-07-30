import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import { useUi, type ComposeInit } from '../../app/store'
import type { Identity, OutgoingAttachment } from '../../domain/identity'
import { t } from '../../lib/i18n'
import { getIdentities, parseAddresses, sendMail, stageAttachment } from '../../services/send'
import { Icon } from '../../ui/Icon'

function addressesToString(list: ComposeInit['to']): string {
  return (list ?? []).map((a) => a.email).join(', ')
}

export function Compose({ accountId, init }: { accountId: string; init: ComposeInit }) {
  const { closeCompose, showSnackbar } = useUi()
  const [identities, setIdentities] = useState<Identity[]>([])
  const [identityId, setIdentityId] = useState<string>('')
  const [to, setTo] = useState(addressesToString(init.to))
  const [cc, setCc] = useState(addressesToString(init.cc))
  const [showCc, setShowCc] = useState(Boolean(init.cc?.length))
  const [subject, setSubject] = useState(init.subject ?? '')
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(init.attachments ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void getIdentities(accountId).then((list) => {
      setIdentities(list)
      if (list[0]) setIdentityId((cur) => cur || list[0]!.id)
    })
  }, [accountId])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: t('compose.placeholder') }),
    ],
    content: init.quotedHtml ? `<p></p>${init.quotedHtml}` : '',
    autofocus: init.to?.length ? 'start' : false,
  })

  async function attach(files: FileList | null) {
    if (!files) return
    for (const file of Array.from(files)) {
      const a = await stageAttachment(accountId, file)
      setAttachments((cur) => [...cur, a])
    }
  }

  async function send() {
    const toList = parseAddresses(to)
    if (!toList.length) {
      setError(t('compose.missingRecipient'))
      return
    }
    const identity = identities.find((i) => i.id === identityId)
    if (!identity || !editor) return
    setBusy(true)
    setError(null)
    try {
      const result = await sendMail(accountId, identity, {
        to: toList,
        cc: parseAddresses(cc),
        bcc: [],
        subject,
        html: editor.getHTML(),
        text: editor.getText(),
        attachments,
        inReplyTo: init.inReplyTo,
        references: init.references,
      })
      closeCompose()
      showSnackbar({
        message: t('mail.sending'),
        actionLabel: t('mail.undo'),
        action: () => {
          void result.undo().then((ok) => {
            if (ok) showSnackbar({ message: t('mail.sendCancelled') }, 4000)
          })
        },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full border-0 border-b border-line bg-transparent px-0 py-2 text-sm outline-none placeholder:text-ink-muted/60'

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/30 sm:items-center sm:p-6">
      <div className="flex h-full w-full flex-col bg-surface sm:h-auto sm:max-h-[85vh] sm:max-w-2xl sm:rounded-2xl sm:border sm:border-line sm:shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-sm font-semibold">{t('compose.new')}</span>
          <button
            type="button"
            onClick={closeCompose}
            title={t('compose.discard')}
            className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {identities.length > 1 && (
            <select
              value={identityId}
              onChange={(e) => setIdentityId(e.target.value)}
              className={field}
            >
              {identities.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name ? `${i.name} <${i.email}>` : i.email}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-2">
            <input
              className={field}
              placeholder={t('compose.to')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoFocus={!init.to?.length}
            />
            {!showCc && (
              <button
                type="button"
                className="text-xs text-ink-muted hover:text-ink"
                onClick={() => setShowCc(true)}
              >
                {t('compose.cc')}
              </button>
            )}
          </div>
          {showCc && (
            <input
              className={field}
              placeholder={t('compose.cc')}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          )}
          <input
            className={`${field} font-medium`}
            placeholder={t('compose.subject')}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          <EditorContent
            editor={editor}
            className="prose prose-sm min-h-40 max-w-none py-3 text-sm [&_.ProseMirror]:outline-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-ink-muted/60 [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-3">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs"
                >
                  <Icon name="paperclip" size={11} />
                  {a.name}
                  <button
                    type="button"
                    className="text-ink-muted hover:text-danger"
                    onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <p className="px-4 py-1 text-sm text-danger">{error}</p>}

        <footer className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            <Icon name="send" size={14} />
            {t('compose.send')}
          </button>
          <button
            type="button"
            title={t('compose.attach')}
            onClick={() => fileInput.current?.click()}
            className="rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="paperclip" size={16} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => void attach(e.target.files)}
          />
        </footer>
      </div>
    </div>
  )
}
