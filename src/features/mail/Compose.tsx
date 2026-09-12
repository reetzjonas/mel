import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useUi, type ComposeInit } from '../../app/store'
import type { Identity, OutgoingAttachment } from '../../domain/identity'
import { t } from '../../lib/i18n'
import { getEmailBody } from '../../services/mail'
import {
  discardDraft,
  getIdentities,
  parseAddresses,
  quoteBlock,
  saveDraft,
  sendMail,
  stageAttachment,
} from '../../services/send'
import { syncAccount } from '../../sync/engine'
import { Icon } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'
import { primaryButtonClass, secondaryButtonClass } from '../../ui/styles'
import { ComposeToolbar } from './ComposeToolbar'
import { useCanSend } from './hooks'
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
  const canSend = useCanSend()
  const navigate = useNavigate()
  // Whatever the app is showing behind this window; `strict: false` because
  // compose is mounted by the shell and knows nothing about the route.
  const routeParams = useParams({ strict: false }) as { mailboxId?: string; emailId?: string }
  const routeRef = useRef(routeParams)
  routeRef.current = routeParams
  const [identities, setIdentities] = useState<Identity[]>([])
  const [identityId, setIdentityId] = useState<string>('')
  const [to, setTo] = useState(addressesToString(init.to))
  const [cc, setCc] = useState(addressesToString(init.cc))
  const [bcc, setBcc] = useState(addressesToString(init.bcc))
  const [showCc, setShowCc] = useState(Boolean(init.cc?.length))
  const [showBcc, setShowBcc] = useState(Boolean(init.bcc?.length))
  const [subject, setSubject] = useState(init.subject ?? '')
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(init.attachments ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [editRevision, setEditRevision] = useState(0)
  const [draftSaved, setDraftSaved] = useState(false)
  /*
   * Anything the window was opened with is *not* a change: reopening a draft
   * and closing it again must not rewrite it (every autosave replaces the
   * message, so an idle reopen would churn through draft ids for nothing).
   */
  const [dirty, setDirty] = useState(false)
  /** Counts the edits, so a save cannot clear `dirty` for a keystroke that
   *  happened while it was in flight. */
  const changeSeq = useRef(0)
  const markDirty = () => {
    changeSeq.current += 1
    setDirty(true)
  }
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      markDirty()
      set(v)
    }
  /** The draft this window owns: reopened, or created by the first save. */
  const draftId = useRef<string | null>(init.draftId ?? null)
  /** The same fact, as state: a ref cannot make the delete button appear. */
  const [hasDraft, setHasDraft] = useState(Boolean(init.draftId))
  const [saving, setSaving] = useState(false)
  /*
   * Saves run one after another. Each one *replaces* the draft (create plus
   * destroy in one Email/set), so two overlapping calls would each replace the
   * other's message and leave a copy behind — and an explicit save that
   * happened to land on an autosave would otherwise have to report a failure
   * that never occurred.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve())

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
    // A reopened draft is its own whole content; a reply gets an empty
    // paragraph above the quote for the answer to go in.
    content: init.bodyHtml ?? (init.quotedHtml ? `<p></p>${init.quotedHtml}` : ''),
    autofocus: init.draftId ? 'end' : init.to?.length ? 'start' : false,
    // The toolbar's pressed state (bold/italic/…) depends on where the cursor
    // is, not just on what was typed — moving into already-bold text has to
    // flip the button with no content change at all.
    onUpdate: () => {
      markDirty()
      setEditRevision((r) => r + 1)
    },
    onSelectionUpdate: () => setEditRevision((r) => r + 1),
  })

  /*
   * The quote, when the message being answered had no body cached yet.
   *
   * Appended at the end of the document with the selection left alone, so it
   * arrives *below* whatever has been typed in the meantime and does not move
   * the cursor out from under the writer. Without this, replying to a message
   * that had just arrived quoted nothing at all — the composer read a body
   * that was still on its way and got null.
   */
  const source = init.quoteSource
  useEffect(() => {
    if (!source || !editor) return
    let alive = true
    void getEmailBody(source.accountId, source.header.id)
      .then((body) => {
        if (!alive || !body || editor.isDestroyed) return
        editor.commands.insertContentAt(
          editor.state.doc.content.size,
          quoteBlock(source.header, body, source.mode),
          { updateSelection: false },
        )
      })
      .catch(() => {
        // Offline, or the server no longer has it: the reply still goes out,
        // just without the quote. Saying so would be noise in a window the
        // user is already writing in.
      })
    return () => {
      alive = false
    }
  }, [editor, source])

  /**
   * Keeps the reading pane on the draft after a save.
   *
   * Saving a draft is create-plus-destroy, not an update: RFC 8621 Emails are
   * immutable apart from `mailboxIds` and `keywords`, so the message gets a
   * **new id** every time. The pane behind this window is routed to the old
   * one, which the next sync deletes — so it emptied out mid-edit instead of
   * following along.
   *
   * The sync is awaited first: routing to an id no row carries yet renders
   * "message not found" until the push-driven sync happens to catch up.
   * `replace`, because the message the previous entry names no longer exists.
   */
  async function followDraft(oldId: string, newId: string) {
    const { mailboxId, emailId } = routeRef.current
    if (!mailboxId || emailId !== oldId) return
    await syncAccount(accountId).catch(() => {})
    await navigate({
      to: '/mail/$mailboxId/$emailId',
      params: { mailboxId, emailId: newId },
      replace: true,
    })
  }

  /**
   * Writes the current fields into the draft this window owns — the one thing
   * both the 2.5 s autosave and the Save button do, so they cannot drift into
   * saving different halves of the form.
   *
   * Text fields only: the real send builds its own message including the
   * attachments, which are staged locally until then.
   */
  const storeDraft = (): Promise<boolean> => {
    const run = async () => {
      const identity = identities.find((i) => i.id === identityId)
      if (!identity || !editor) return false
      const seq = changeSeq.current
      const { id, ok } = await saveDraft(
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
      const previous = draftId.current
      draftId.current = id
      if (ok) {
        if (id && previous && id !== previous) await followDraft(previous, id)
        setHasDraft(true)
        setDraftSaved(true)
        // Anything typed while this was in flight is still unsaved, and the
        // next autosave has to pick it up.
        if (changeSeq.current === seq) setDirty(false)
      }
      return ok
    }
    const next = queue.current.then(run, run)
    queue.current = next
    return next
  }
  // The timer below is armed by the deps, not re-armed on every render, so it
  // must not close over a stale copy of the function.
  const storeDraftRef = useRef(storeDraft)
  storeDraftRef.current = storeDraft

  // Draft autosave: 2.5 s after the last change.
  useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => void storeDraftRef.current(), 2500)
    return () => clearTimeout(timer)
  }, [
    dirty,
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

  /**
   * Save on demand. The autosave only fires 2.5 s after the last change, which
   * is invisible from outside — closing the window inside that window dropped
   * the edit with nothing to show for it, and there was no way to make sure.
   */
  async function saveNow() {
    if (!navigator.onLine) {
      setError(t('compose.saveOffline'))
      return
    }
    setSaving(true)
    setError(null)
    const ok = await storeDraft()
    setSaving(false)
    if (!ok) setError(t('compose.saveFailed'))
  }

  /** Throws the stored draft away and closes — the counterpart to sending it. */
  async function deleteDraft() {
    const id = draftId.current
    if (!id) return
    draftId.current = null
    setHasDraft(false)
    await discardDraft(accountId, id)
    closeCompose()
    showSnackbar({ message: t('compose.draftDeleted') }, 4000)
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
          <span className="text-sm font-semibold">
            {init.draftId ? t('compose.editDraft') : t('compose.new')}
          </span>
          <Tooltip label={t('compose.discard')}>
            <button
              type="button"
              onClick={closeCompose}
              aria-label={t('compose.discard')}
              className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="close" size={16} />
            </button>
          </Tooltip>
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
                onChange={(e) => changed(setIdentityId)(e.target.value)}
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
            onChange={changed(setTo)}
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
              onChange={changed(setCc)}
            />
          )}
          {showBcc && (
            <RecipientRow
              accountId={accountId}
              label={t('compose.bcc')}
              placeholder={t('compose.bcc')}
              value={bcc}
              onChange={changed(setBcc)}
            />
          )}
          <div className={fieldRowClass}>
            <input
              className="w-full border-0 bg-transparent px-0 py-2 text-sm font-medium outline-none placeholder:text-ink-muted/60"
              placeholder={t('compose.subject')}
              value={subject}
              onChange={(e) => changed(setSubject)(e.target.value)}
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
                  <Tooltip label={t('compose.removeAttachment')}>
                    <button
                      type="button"
                      aria-label={`${t('compose.removeAttachment')}: ${a.name}`}
                      className="text-ink-muted hover:text-danger"
                      onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </Tooltip>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <p className="px-4 py-1 text-sm text-danger">{error}</p>}

        <footer className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          {/*
           * Reachable without the submission capability only by reopening a
           * draft — every way of starting a new message is already gone by
           * then. Disabled rather than hidden, because the reason belongs
           * next to the button someone came here to press.
           */}
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || !canSend}
            title={canSend ? undefined : t('caps.unsupported.submission')}
            className={`flex items-center gap-2 ${primaryButtonClass}`}
          >
            <Icon name="send" size={14} />
            {t('compose.send')}
          </button>
          {!canSend && (
            <span className="text-xs text-ink-muted">{t('caps.unsupported.submission')}</span>
          )}
          {/* Secondary, next to Send: the same act the autosave performs, on
              demand. Disabled while one is running rather than queueing a
              second identical write behind it. */}
          <button
            type="button"
            onClick={() => void saveNow()}
            disabled={saving || busy}
            className={secondaryButtonClass}
          >
            {t('compose.saveDraft')}
          </button>
          <Tooltip label={t('compose.attach')}>
            <button
              type="button"
              aria-label={t('compose.attach')}
              onClick={() => fileInput.current?.click()}
              className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Icon name="paperclip" size={16} />
            </button>
          </Tooltip>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => void attach(e.target.files)}
          />
          {/* Only once the draft exists: throwing away a message that was
              never stored is what the close button already does. */}
          {hasDraft && (
            <Tooltip label={t('compose.deleteDraft')}>
              <button
                type="button"
                aria-label={t('compose.deleteDraft')}
                onClick={() => void deleteDraft()}
                className="rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-danger"
              >
                <Icon name="trash" size={16} />
              </button>
            </Tooltip>
          )}
          {/* Says which of the two it is. "Draft saved" left standing over
              unsaved edits is exactly what made the autosave look broken. */}
          {(dirty || draftSaved) && (
            <span className="ml-auto text-xs text-ink-muted">
              {dirty ? t('compose.unsavedChanges') : t('compose.draftSaved')}
            </span>
          )}
        </footer>
      </div>
    </div>
  )
}
