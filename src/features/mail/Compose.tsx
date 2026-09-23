import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, Extension, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useUi, type ComposeInit } from '../../app/store'
import type { Identity, OutgoingAttachment } from '../../domain/identity'
import { t } from '../../lib/i18n'
import {
  inlineAttachments,
  isInlineImageType,
  newCid,
  stillReferenced,
} from '../../lib/inlineImages'
import { getEmailBody } from '../../services/mail'
import {
  discardDraft,
  fileAttachments,
  getIdentities,
  parseAddresses,
  quoteBlock,
  saveDraft,
  sendMail,
  stageAttachment,
} from '../../services/send'
import { connectionFor } from '../../sync/connections'
import { syncAccount } from '../../sync/engine'
import { DialogHeader } from '../../ui/DialogHeader'
import { Icon } from '../../ui/Icon'
import { Tooltip } from '../../ui/Tooltip'
import { useMobileViewport, useModal } from '../../ui/useModal'
import { ComposeToolbar } from './ComposeToolbar'
import { SecurityNotices, SecurityToggles } from './ComposeSecurity'
import { secureProblemText, useHasOwnKey } from './secureSend'
import type { SecureOptions, SecureSendError } from '../../services/pgpWrite'
import { InlineImage, inlineImageStorage, setInlineImageUrl } from './composeImage'
import { useCanSend } from './hooks'
import { RecipientInput } from './RecipientInput'

function addressesToString(list: ComposeInit['to']): string {
  return (list ?? []).map((a) => a.email).join(', ')
}

/** "12 KB", "3.4 MB": enough to tell a screenshot from a video. */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Files from a paste or a drop, split into pictures for the text and files to attach. */
function splitFiles(files: FileList | File[] | null | undefined): {
  images: File[]
  others: File[]
} {
  const list = Array.from(files ?? [])
  return {
    images: list.filter((f) => isInlineImageType(f.type)),
    others: list.filter((f) => !isInlineImageType(f.type)),
  }
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
          className="min-h-11 w-full border-0 bg-transparent px-0 py-2 text-sm outline-none placeholder:text-ink-muted/60 sm:min-h-0"
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

export function Compose({
  accountId,
  init,
  onClose,
}: {
  accountId: string
  init: ComposeInit
  onClose: () => void
}) {
  const { showSnackbar } = useUi()
  const canSend = useCanSend()
  const navigate = useNavigate()
  // Whatever the app is showing behind this window; `strict: false` because
  // compose is mounted by the shell and knows nothing about the route.
  const routeParams = useParams({ strict: false }) as { mailboxId?: string; emailId?: string }
  const routeRef = useRef(routeParams)
  // Latest ref, during render on purpose — see shortcuts.ts for the reasoning.
  // Compose is mounted by the shell and outlives any one route.
  // oxlint-disable-next-line refs
  routeRef.current = routeParams
  const [identities, setIdentities] = useState<Identity[]>([])
  const [identityId, setIdentityId] = useState<string>('')
  const [to, setTo] = useState(addressesToString(init.to))
  const [cc, setCc] = useState(addressesToString(init.cc))
  const [bcc, setBcc] = useState(addressesToString(init.bcc))
  const [showCc, setShowCc] = useState(Boolean(init.cc?.length))
  const [showBcc, setShowBcc] = useState(Boolean(init.bcc?.length))
  const [subject, setSubject] = useState(init.subject ?? '')
  /*
   * OpenPGP (issue #63). Offered only once the user has a key here; a reply
   * to an encrypted message starts out encrypted.
   */
  const hasKey = useHasOwnKey(accountId)
  const [secureChoice, setSecureChoice] = useState<SecureOptions>({
    encrypt: Boolean(init.encrypt),
    sign: Boolean(init.encrypt),
  })
  const secure: SecureOptions = hasKey ? secureChoice : { encrypt: false, sign: false }
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(init.attachments ?? [])
  /*
   * Pictures drawn in the text. Kept apart from the attachment chips: they are
   * shown where they sit in the message, and one whose `<img>` is deleted is
   * simply left out when the message is saved or sent (`stillReferenced`).
   */
  const [inlineImages, setInlineImages] = useState<OutgoingAttachment[]>(init.inlineImages ?? [])
  const [dragging, setDragging] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null)
  /** Object URLs made for the editor's pictures, revoked when the window closes. */
  const objectUrls = useRef<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<HTMLElement>(null)
  const mobileViewport = useMobileViewport()
  useModal({ panel, initialFocus, onClose })
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

  /*
   * What the editor's paste, drop and keyboard handlers call. The editor is
   * built once, so they reach the current functions through this ref rather
   * than closing over the first render's copies.
   */
  const handlers = useRef({
    insertImages: (_files: File[], _at?: number) => {},
    attach: (_files: File[]) => {},
    send: () => {},
  })

  const editor = useEditor({
    extensions: [
      // Link lives in StarterKit itself (v3) — a second, separately imported
      // Link extension registered under the same name and Tiptap warned about
      // it on every mount. Configuring the bundled one is the fix, not a
      // second import.
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: t('compose.placeholder') }),
      InlineImage,
      // Ahead of StarterKit's hard break, which claims Mod-Enter as well.
      Extension.create({
        name: 'sendShortcut',
        priority: 1000,
        addKeyboardShortcuts: () => ({
          'Mod-Enter': () => {
            handlers.current.send()
            return true
          },
        }),
      }),
    ],
    editorProps: {
      handlePaste: (_view, event) => {
        const { images, others } = splitFiles(event.clipboardData?.files)
        if (!images.length && !others.length) return false
        if (images.length) handlers.current.insertImages(images)
        if (others.length) handlers.current.attach(others)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const { images, others } = splitFiles(event.dataTransfer?.files)
        if (!images.length && !others.length) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        if (images.length) handlers.current.insertImages(images, at)
        if (others.length) handlers.current.attach(others)
        setDragging(false)
        return true
      },
    },
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
        setInlineImages((cur) => [...cur, ...inlineAttachments(body)])
        if (source.mode === 'forward') setAttachments((cur) => [...cur, ...fileAttachments(body)])
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

  /*
   * Display URLs for pictures that arrived with the window — a reopened
   * draft's, a quote's. They are on the server already; the ones added here
   * got their URL when they were staged.
   */
  useEffect(() => {
    if (!editor) return
    const storage = inlineImageStorage(editor)
    const missing = inlineImages.filter((a) => a.cid && a.blobId && !storage.urls.has(a.cid))
    if (!missing.length) return
    let alive = true
    void (async () => {
      const conn = await connectionFor(accountId).catch(() => null)
      if (!conn?.mail) return
      for (const a of missing) {
        try {
          const blob = await conn.mail.downloadBlob(a.blobId!, a.type, a.name)
          if (!alive || editor.isDestroyed) return
          const url = URL.createObjectURL(new Blob([blob], { type: a.type }))
          objectUrls.current.push(url)
          setInlineImageUrl(storage, a.cid!, url)
        } catch {
          // Offline or gone: the picture stays a placeholder, and still goes out.
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [editor, inlineImages, accountId])

  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url)
    },
    [],
  )

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
   * the 2.5 s autosave writes, so every automatic save captures the same
   * fields.
   *
   * Attachments and pictures included: one staged only locally is uploaded
   * on the first save that carries it (see `saveDraft`).
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
          attachments: outgoingAttachments(editor),
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
  // As above: the autosave timer is armed by its deps and not re-armed per
  // render, so it must not close over a stale copy of this function.
  // oxlint-disable-next-line refs
  storeDraftRef.current = storeDraft

  // Draft autosave: 2.5 s after the last change. Not while encrypting: a draft
  // is stored on the server as it is, and this one is meant not to be readable
  // there.
  useEffect(() => {
    if (!dirty || secure.encrypt) return
    const timer = setTimeout(() => void storeDraftRef.current(), 2500)
    return () => clearTimeout(timer)
  }, [
    dirty,
    secure.encrypt,
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

  /** Files beside the text, and the pictures in it that are still there. */
  function outgoingAttachments(ed: Editor): OutgoingAttachment[] {
    return [...attachments, ...stillReferenced(ed.getHTML(), inlineImages)]
  }

  async function attach(files: FileList | File[] | null) {
    if (!files) return
    for (const file of Array.from(files)) {
      const a = await stageAttachment(accountId, file)
      markDirty()
      setAttachments((cur) => [...cur, a])
    }
  }

  /**
   * Puts pictures into the text: staged locally like an attachment (so this
   * works offline too), drawn from an object URL, referenced by a fresh cid.
   */
  async function insertImages(files: File[], at?: number) {
    if (!editor) return
    const storage = inlineImageStorage(editor)
    let pos = at
    for (const file of files) {
      const cid = newCid()
      const staged = await stageAttachment(accountId, file, cid)
      const url = URL.createObjectURL(file)
      objectUrls.current.push(url)
      setInlineImageUrl(storage, cid, url)
      setInlineImages((cur) => [...cur, staged])
      const node = { type: 'inlineImage', attrs: { src: `cid:${cid}`, alt: file.name } }
      if (pos === undefined) editor.chain().focus().insertContent(node).run()
      else {
        editor.chain().focus().insertContentAt(pos, node).run()
        pos += 1
      }
    }
  }

  function dropOnPanel(event: React.DragEvent) {
    // The editor takes its own drops (pictures go where they are dropped);
    // anywhere else in the window, a dropped file is an attachment.
    setDragging(false)
    // Already taken by the editor, which prevents the default of what it handles.
    if (event.nativeEvent.defaultPrevented || !event.dataTransfer.files.length) return
    event.preventDefault()
    void attach(event.dataTransfer.files)
  }

  // oxlint-disable-next-line refs
  handlers.current = {
    insertImages: (files, at) => void insertImages(files, at),
    attach: (files) => void attach(files),
    send: () => void send(),
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
    onClose()
    showSnackbar({ message: t('compose.draftDeleted') }, 4000)
  }

  async function send() {
    const toList = parseAddresses(to)
    if (!toList.length) {
      setError(t('compose.missingRecipient'))
      return
    }
    const identity = identities.find((i) => i.id === identityId)
    if (!identity || !editor || busy) return
    setBusy(true)
    setError(null)
    try {
      // A save still in flight would replace the draft after the send named
      // it, and the replacement would be left behind in Drafts.
      await queue.current.catch(() => {})
      const result = await sendMail(accountId, identity, {
        to: toList,
        cc: parseAddresses(cc),
        bcc: parseAddresses(bcc),
        subject,
        html: editor.getHTML(),
        text: editor.getText(),
        attachments: outgoingAttachments(editor),
        inReplyTo: init.inReplyTo,
        references: init.references,
        // Destroyed by the send once it is out, so an undo leaves it in place.
        draftId: draftId.current,
        secure,
      })
      onClose()
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
      const problem = e instanceof Error && 'problem' in e ? (e as SecureSendError).problem : null
      // A missing key or a locked one is already said, live, by the notice
      // above the footer, which goes away once fixed; a copy of it here would
      // stay standing after the recipient was corrected.
      if (problem?.kind === 'missingKeys' || problem?.kind === 'locked') return
      setError(problem ? secureProblemText(problem) : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center sm:p-6"
      style={mobileViewport ? { bottom: mobileViewport.inset } : undefined}
    >
      {/*
       * `sm:h-auto` used to size the panel to its content, so a short message
       * left the editor at little more than one line and a lot of visibly
       * empty space below it before the footer — the body never got to use
       * the room the panel already had. A real height instead of `auto` makes
       * the editor's `flex-1` below unambiguous: it fills exactly what's left
       * after the fixed header fields, in every browser, not just when there
       * happens to be enough content to reach the max-height on its own.
       */}
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-label={init.draftId ? t('compose.editDraft') : t('compose.new')}
        className="animate-rise relative flex h-full w-full flex-col bg-raised sm:h-[min(640px,75vh)] sm:max-w-2xl sm:rounded-panel sm:shadow-overlay sm:ring-1 sm:ring-line"
        style={mobileViewport ? { height: `${mobileViewport.height}px` } : undefined}
        onKeyDown={(e) => {
          // The editor handles its own (see `sendShortcut`); this covers the fields.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
            e.preventDefault()
            void send()
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          // Leaving for a child is not leaving the window.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={dropOnPanel}
      >
        {dragging && (
          <div
            className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-panel border-2 border-dashed border-accent bg-accent-wash/70 text-sm font-medium text-accent"
            aria-hidden
          >
            {t('compose.dropFiles')}
          </div>
        )}
        <DialogHeader
          title={init.draftId ? t('compose.editDraft') : t('compose.new')}
          closeLabel={t('compose.discard')}
          onClose={onClose}
          action={
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !canSend}
              title={canSend ? undefined : t('caps.unsupported.submission')}
              className="text-sm font-semibold text-ink-muted hover:text-accent disabled:text-ink-subtle"
            >
              {t('compose.send')}
            </button>
          }
        />

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
        <div
          ref={(element) => {
            initialFocus.current = element?.querySelector('input') ?? null
          }}
          className="shrink-0 px-4"
        >
          {identities.length > 1 && (
            <div className={fieldRowClass}>
              <span className="w-10 shrink-0 text-xs text-ink-subtle" aria-hidden>
                {t('compose.from')}
              </span>
              <select
                aria-label={t('compose.from')}
                value={identityId}
                onChange={(e) => changed(setIdentityId)(e.target.value)}
                className="min-h-11 min-w-0 flex-1 border-0 bg-transparent px-0 py-2 text-sm outline-none sm:min-h-0"
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
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-ink"
                    onClick={() => setShowCc(true)}
                  >
                    {t('compose.cc')}
                  </button>
                )}
                {!showBcc && (
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-ink"
                    onClick={() => setShowBcc(true)}
                  >
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
              className="min-h-11 w-full border-0 bg-transparent px-0 py-2 text-sm font-medium outline-none placeholder:text-ink-muted/60 sm:min-h-0"
              placeholder={t('compose.subject')}
              value={subject}
              onChange={(e) => changed(setSubject)(e.target.value)}
            />
          </div>

          <ComposeToolbar editor={editor} onInsertImage={() => imageInput.current?.click()} />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const { images, others } = splitFiles(e.target.files)
              if (images.length) void insertImages(images)
              if (others.length) void attach(others)
              e.target.value = ''
            }}
          />
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
                  <span className="text-ink-muted">({formatSize(a.size)})</span>
                  <Tooltip label={t('compose.removeAttachment')}>
                    <button
                      type="button"
                      aria-label={`${t('compose.removeAttachment')}: ${a.name}`}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink-muted hover:bg-danger-wash hover:text-danger sm:min-h-0 sm:min-w-0"
                      onClick={() => {
                        markDirty()
                        setAttachments((cur) => cur.filter((_, j) => j !== i))
                      }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </Tooltip>
                </span>
              ))}
            </div>
          )}
        </div>

        {hasKey && (
          <SecurityNotices
            accountId={accountId}
            value={secure}
            recipients={[...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)]}
          />
        )}
        {error && <p className="px-4 py-1 text-sm text-danger">{error}</p>}

        <footer className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          {!canSend && (
            <span className="text-xs text-ink-muted">{t('caps.unsupported.submission')}</span>
          )}
          <Tooltip label={t('compose.attach')}>
            <button
              type="button"
              aria-label={t('compose.attach')}
              onClick={() => fileInput.current?.click()}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink sm:min-h-0 sm:min-w-0"
            >
              <Icon name="paperclip" size={16} />
            </button>
          </Tooltip>
          {hasKey && <SecurityToggles value={secure} onChange={setSecureChoice} />}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void attach(e.target.files)
              // Picking the same file again after removing it should still attach it.
              e.target.value = ''
            }}
          />
          {/* Only once the draft exists: throwing away a message that was
              never stored is what the close button already does. */}
          {hasDraft && (
            <Tooltip label={t('compose.deleteDraft')}>
              <button
                type="button"
                aria-label={t('compose.deleteDraft')}
                onClick={() => void deleteDraft()}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-danger sm:min-h-0 sm:min-w-0"
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
          <Tooltip label={t('compose.saveDraft')}>
            <button
              type="button"
              aria-label={t('compose.saveDraft')}
              onClick={() => void saveNow()}
              // An encrypted message is not stored as a draft (see the autosave).
              disabled={saving || busy || secure.encrypt}
              className={`${dirty || draftSaved ? '' : 'ml-auto '}flex min-h-11 min-w-11 items-center justify-center rounded-control p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50 sm:min-h-0 sm:min-w-0`}
            >
              <Icon name="save" size={16} />
            </button>
          </Tooltip>
        </footer>
      </div>
    </div>
  )
}
