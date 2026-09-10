import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import { useUi, type ComposeInit } from '../../app/store'
import type { Identity, OutgoingAttachment } from '../../domain/identity'
import { t } from '../../lib/i18n'
import {
  discardDraft,
  getIdentities,
  parseAddresses,
  saveDraft,
  sendMail,
  stageAttachment,
} from '../../services/send'
import { Icon } from '../../ui/Icon'
import { primaryButtonClass } from '../../ui/styles'
import { ComposeToolbar } from './ComposeToolbar'
import { RecipientInput } from './RecipientInput'

function addressesToString(list: ComposeInit['to']): string {
  return (list ?? []).map((a) => a.email).join(', ')
}

/*
 * Shared by every label+field row (recipients, From, Subject). The border sits
 * on this wrapper, not on the input, so it can span the label too — but the
 * global focus ring (`:focus-visible` in index.css, outline 2px + 2px offset)
 * targets the input itself. Flush against the input's edge, that ring's own
 * edge crossed a border line and made it look broken right where a field was
 * focused — its *own* border below (fixed by `pb-1`) and, just as much, the
 * *previous* row's border immediately above with nothing but `pt-1` telling
 * them apart. Both paddings are that ring's footprint, symmetric, so every
 * border on either side of a row has room to stay a clean unbroken line.
 */
const fieldRowClass = 'flex items-center gap-2 border-b border-line py-1'

/** One recipient row: a fixed-width label plus the input, matching the subject row below it. */
function RecipientRow({
  accountId,
  label,
  placeholder,
  value,
  onChange,
  autoFocus,
  trailing,
}: {
  accountId: string
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  trailing?: React.ReactNode
}) {
  return (
    <div className={fieldRowClass}>
      <span className="w-10 shrink-0 text-xs text-ink-subtle" aria-hidden>
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <RecipientInput
          accountId={accountId}
          className="w-full border-0 bg-transparent px-0 py-2 text-sm outline-none placeholder:text-ink-muted/60"
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          autoFocus={autoFocus}
        />
      </div>
      {trailing}
    </div>
  )
}

export function Compose({ accountId, init }: { accountId: string; init: ComposeInit }) {
  const { closeCompose, showSnackbar } = useUi()
  const [identities, setIdentities] = useState<Identity[]>([])
  const [identityId, setIdentityId] = useState<string>('')
  const [to, setTo] = useState(addressesToString(init.to))
  const [cc, setCc] = useState(addressesToString(init.cc))
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(Boolean(init.cc?.length))
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState(init.subject ?? '')
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(init.attachments ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [editRevision, setEditRevision] = useState(0)
  const [draftSaved, setDraftSaved] = useState(false)
  const draftId = useRef<string | null>(null)
  const draftBusy = useRef(false)

  useEffect(() => {
    void getIdentities(accountId).then((list) => {
      setIdentities(list)
      if (list[0]) setIdentityId((cur) => cur || list[0]!.id)
    })
  }, [accountId])

  const editor = useEditor({
    extensions: [
      // Link lives in StarterKit itself (v3) — a second, separately imported
      // Link extension registered under the same name and Tiptap warned about
      // it on every mount. Configuring the bundled one is the fix, not a
      // second import.
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: t('compose.placeholder') }),
    ],
    content: init.quotedHtml ? `<p></p>${init.quotedHtml}` : '',
    autofocus: init.to?.length ? 'start' : false,
    // The toolbar's pressed state (bold/italic/…) depends on where the cursor
    // is, not just on what was typed — moving into already-bold text has to
    // flip the button with no content change at all.
    onUpdate: () => setEditRevision((r) => r + 1),
    onSelectionUpdate: () => setEditRevision((r) => r + 1),
  })

  // Draft autosave: 2.5 s after the last change (text fields only; the real
  // send builds its own message including attachments).
  useEffect(() => {
    if (editRevision === 0 && !subject && !to) return
    const identity = identities.find((i) => i.id === identityId)
    if (!identity || !editor) return
    const timer = setTimeout(() => {
      if (draftBusy.current) return
      draftBusy.current = true
      void saveDraft(
        accountId,
        identity,
        {
          to: parseAddresses(to),
          cc: parseAddresses(cc),
          bcc: parseAddresses(bcc),
          subject,
          html: editor.getHTML(),
          text: editor.getText(),
          inReplyTo: init.inReplyTo,
          references: init.references,
        },
        draftId.current,
      )
        .then((id) => {
          draftId.current = id
          if (id) setDraftSaved(true)
        })
        .finally(() => {
          draftBusy.current = false
        })
    }, 2500)
    return () => clearTimeout(timer)
  }, [
    to,
    cc,
    bcc,
    subject,
    editRevision,
    identityId,
    identities,
    accountId,
    editor,
    init.inReplyTo,
    init.references,
  ])

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
        bcc: parseAddresses(bcc),
        subject,
        html: editor.getHTML(),
        text: editor.getText(),
        attachments,
        inReplyTo: init.inReplyTo,
        references: init.references,
      })
      if (draftId.current) void discardDraft(accountId, draftId.current)
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

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6">
      {/*
       * `sm:h-auto` used to size the panel to its content, so a short message
       * left the editor at little more than one line and a lot of visibly
       * empty space below it before the footer — the body never got to use
       * the room the panel already had. A real height instead of `auto` makes
       * the editor's `flex-1` below unambiguous: it fills exactly what's left
       * after the fixed header fields, in every browser, not just when there
       * happens to be enough content to reach the max-height on its own.
       */}
      <div className="animate-rise flex h-full w-full flex-col bg-raised sm:h-[min(640px,75vh)] sm:max-w-2xl sm:rounded-panel sm:shadow-overlay sm:ring-1 sm:ring-line">
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-sm font-semibold">{t('compose.new')}</span>
          <button
            type="button"
            onClick={closeCompose}
            title={t('compose.discard')}
            aria-label={t('compose.discard')}
            className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {/*
         * Recipient/subject/toolbar are fixed chrome, not part of the scroll
         * region: they used to share the editor's `overflow-y-auto` box, which
         * clipped the To field's focus ring against the box's own top edge —
         * an outline needs a few pixels of room around the element, and a
         * scroll container clips anything past its own bounds, ring included.
         * Only the message body scrolls now, and it fills whatever height is
         * left instead of stopping at a fixed min-height.
         *
         * No extra top padding needed here for the header's border above: the
         * first field row's own `py-1` (see `fieldRowClass`) already covers
         * it, on top of the header's own py-2.5.
         */}
        <div className="shrink-0 px-4">
          {identities.length > 1 && (
            <div className={fieldRowClass}>
              <span className="w-10 shrink-0 text-xs text-ink-subtle" aria-hidden>
                {t('compose.from')}
              </span>
              <select
                aria-label={t('compose.from')}
                value={identityId}
                onChange={(e) => setIdentityId(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent px-0 py-2 text-sm outline-none"
              >
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name ? `${i.name} <${i.email}>` : i.email}
                  </option>
                ))}
              </select>
            </div>
          )}

          <RecipientRow
            accountId={accountId}
            label={t('compose.to')}
            placeholder={t('compose.to')}
            value={to}
            onChange={setTo}
            autoFocus={!init.to?.length}
            trailing={
              <span className="flex shrink-0 gap-2 text-xs text-ink-muted">
                {!showCc && (
                  <button type="button" className="hover:text-ink" onClick={() => setShowCc(true)}>
                    {t('compose.cc')}
                  </button>
                )}
                {!showBcc && (
                  <button type="button" className="hover:text-ink" onClick={() => setShowBcc(true)}>
                    {t('compose.bcc')}
                  </button>
                )}
              </span>
            }
          />
          {showCc && (
            <RecipientRow
              accountId={accountId}
              label={t('compose.cc')}
              placeholder={t('compose.cc')}
              value={cc}
              onChange={setCc}
            />
          )}
          {showBcc && (
            <RecipientRow
              accountId={accountId}
              label={t('compose.bcc')}
              placeholder={t('compose.bcc')}
              value={bcc}
              onChange={setBcc}
            />
          )}
          <div className={fieldRowClass}>
            <input
              className="w-full border-0 bg-transparent px-0 py-2 text-sm font-medium outline-none placeholder:text-ink-muted/60"
              placeholder={t('compose.subject')}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <ComposeToolbar editor={editor} />
        </div>

        {/*
         * Not `prose`/`prose-sm`: @tailwindcss/typography isn't installed, so
         * those classes were dead weight doing nothing. List, blockquote and
         * link styling for this editor lives in the global `.ProseMirror`
         * rules in index.css instead — Preflight resets ul/ol list-style
         * app-wide, which otherwise left the toolbar's own list buttons
         * inserting bullets and numbers that don't render as either.
         */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <EditorContent editor={editor} className="flex h-full flex-col py-3 text-sm" />
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
                    title={t('compose.removeAttachment')}
                    aria-label={`${t('compose.removeAttachment')}: ${a.name}`}
                    className="text-ink-muted hover:text-danger"
                    onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={11} />
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
            className={`flex items-center gap-2 ${primaryButtonClass}`}
          >
            <Icon name="send" size={14} />
            {t('compose.send')}
          </button>
          <button
            type="button"
            title={t('compose.attach')}
            aria-label={t('compose.attach')}
            onClick={() => fileInput.current?.click()}
            className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
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
          {draftSaved && (
            <span className="ml-auto text-xs text-ink-muted">{t('compose.draftSaved')}</span>
          )}
        </footer>
      </div>
    </div>
  )
}
