# Inline images in compose (issue #9)

A picture pasted, dropped or inserted into the text of a message travels
*inside* it: a MIME part with a Content-ID, referenced from the HTML as
`<img src="cid:…">` (RFC 2392). This note is about where that reference lives
and what the server does and does not do for us.

## The document holds the reference, not the picture

`features/mail/composeImage.ts` is a Tiptap node whose `src` is the `cid:`
URL itself. Only its node view swaps that for something the browser can draw
(an object URL, from `setInlineImageUrl`). So `editor.getHTML()` is already
the body to send or save — no step has to turn display URLs back into
references, and a `blob:` URL can never leak into a sent message, where it
would be a broken image for everyone else.

The node takes only `cid:` and `data:image/…` sources. A remote picture in
pasted or quoted HTML is dropped, as it was before the node existed (StarterKit
has no image node): drawing it would fetch the tracking pixel of the message
being answered, and sending it on would pass the tracker along.

The storage the node view reads is `this.storage` captured in `addNodeView`.
`extension.storage` in the view's props is *not* the editor's instance in
Tiptap 3 — the pictures stayed blank until this was found by the e2e test.

## Where pictures come from

- **Added here** — toolbar button, paste (a screenshot), or a drop onto the
  text: staged in `blobCache` like any attachment (so it works offline), with a
  fresh `newCid()`. A file that is not a picture, pasted or dropped, becomes an
  ordinary attachment; anything dropped elsewhere on the window is attached.
- **A reopened draft, or a quote** — `inlineAttachments(body)` turns the parts
  the HTML refers to into outgoing pictures that reuse the blob on the server;
  the composer downloads each once for display. A forward also passes the
  message's files on (`fileAttachments`); a reply does not send files back to
  the person who sent them.

A picture whose `<img>` was deleted while writing is left out of the saved or
sent message (`stillReferenced`) rather than going out as an invisible part.

## The MIME structure is spelled out

RFC 8621 lets a client describe a body by shorthand (`textBody`, `htmlBody`,
`attachments`) and leave the structure to the server. **Stalwart (0.16) puts
an inline part loose into the `multipart/mixed` beside the files** instead of
building a `multipart/related` with the HTML — checked in the e2e test against
the real server. Apple Mail and Outlook then list the picture as an attachment
rather than drawing it. So with any inline picture, `outgoingBody()`
(`providers/jmap/mail.ts`) sends a full `bodyStructure`:

    multipart/mixed              (only when there are files)
    ├─ multipart/alternative
    │  ├─ text/plain
    │  └─ multipart/related
    │     ├─ text/html
    │     └─ image/* (inline, Content-ID) …
    └─ files …

Without inline pictures the shorthand stays, unchanged from before.

## Reading

The reading pane resolved no `cid:` at all before this — received inline
pictures were broken images, whoever sent them. `useInlineImageUrls` now
fetches the parts the HTML refers to and hands the frame `data:` URLs:

- `data:`, not object URLs: the body renders in a sandboxed frame with an
  opaque origin, which may not read a `blob:` URL the page made, and the
  frame's CSP already allows `data:` for exactly this — the bytes are part of
  the message, so showing them tells the sender nothing.
- The frame waits for them (`framePending`), for the same reason it waits for
  the image permission: drawing it twice is a second navigation of the frame.
  A picture that cannot be fetched is left out, not waited on.
- A part drawn in the body is not also listed as an attachment chip.
- Not cached for offline use yet: an inline picture needs the network the
  first time, like any attachment.

## Tests

Unit: `lib/inlineImages.test.ts`, the body structure in
`providers/jmap/mail.test.ts`, draft upload-once in `services/send.test.ts`,
send-then-destroy in `sync/outboxExecute.test.ts`. End to end against
Stalwart: `compose.spec.ts` (sent inline, checked in the server's
`bodyStructure`, drawn on the other side, forwarded; drops) and
`folders-drafts.spec.ts` (draft round trip, then sent).
