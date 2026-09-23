import { describe, expect, it } from 'vitest'
import type { EmailBody, EmailBodyPart } from '../domain/email'
import {
  inlineAttachments,
  inlineParts,
  isInlineImageType,
  newCid,
  referencedCids,
  resolveCids,
  stillReferenced,
} from './inlineImages'

const part = (over: Partial<EmailBodyPart>): EmailBodyPart => ({
  partId: '2',
  blobId: 'b1',
  type: 'image/png',
  name: 'logo.png',
  disposition: 'inline',
  cid: 'logo@x',
  size: 5,
  ...over,
})

const body = (html: string | null, attachments: EmailBodyPart[]): EmailBody => ({
  emailId: 'm1',
  html,
  text: null,
  attachments,
  messageId: null,
  references: null,
})

describe('cid references in HTML', () => {
  it('finds them in either quote style, decoded and without brackets', () => {
    const html = `<img src="cid:a@x"><img alt='' src='cid:b%40x'><img src="https://t.example/p.gif">`
    expect([...referencedCids(html)]).toEqual(['a@x', 'b@x'])
  })

  it('points each known reference at its URL and leaves the rest alone', () => {
    const html = '<img src="cid:a@x"> <img src="cid:missing@x">'
    expect(resolveCids(html, { 'a@x': 'data:image/png;base64,AA' })).toBe(
      '<img src="data:image/png;base64,AA"> <img src="cid:missing@x">',
    )
  })

  it('makes a fresh, unique Content-ID for each picture added', () => {
    const a = newCid()
    expect(a).toMatch(/@mel$/)
    expect(newCid()).not.toBe(a)
  })

  it('takes pictures a browser draws, not every image type', () => {
    expect(isInlineImageType('image/png')).toBe(true)
    expect(isInlineImageType('image/JPEG')).toBe(true)
    expect(isInlineImageType('image/tiff')).toBe(false)
    expect(isInlineImageType('application/pdf')).toBe(false)
  })
})

describe('the parts a body draws', () => {
  it('are the ones its HTML refers to, whatever brackets the server left on the cid', () => {
    const b = body('<img src="cid:logo@x">', [
      part({ cid: '<logo@x>' }),
      part({ partId: '3', cid: 'unused@x' }),
      part({ partId: '4', cid: null }),
    ])
    expect([...inlineParts(b).keys()]).toEqual(['logo@x'])
  })

  it('are none for a plain-text body, or a part the server holds no blob for', () => {
    expect(inlineParts(body(null, [part({})])).size).toBe(0)
    expect(inlineParts(body('<img src="cid:logo@x">', [part({ blobId: null })])).size).toBe(0)
  })

  it('become outgoing pictures that reuse the blob on the server', () => {
    expect(inlineAttachments(body('<img src="cid:logo@x">', [part({})]))).toEqual([
      { blobId: 'b1', localKey: null, name: 'logo.png', type: 'image/png', size: 5, cid: 'logo@x' },
    ])
  })
})

describe('pictures still in the text', () => {
  it('drops one whose image was deleted while writing', () => {
    const kept = {
      blobId: 'b1',
      localKey: null,
      name: 'a',
      type: 'image/png',
      size: 1,
      cid: 'a@mel',
    }
    const gone = { ...kept, cid: 'b@mel' }
    expect(stillReferenced('<p><img src="cid:a@mel"></p>', [kept, gone])).toEqual([kept])
  })
})
