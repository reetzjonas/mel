import { describe, expect, it } from 'vitest'
import { hasRemoteContent, mailFrameDoc, textFrameDoc } from './htmlSanitize'

const imgSrc = (doc: string) => /img-src ([^;"]*)/.exec(doc)?.[1]?.trim()

describe('remote content policy', () => {
  it('blocks http(s) images by default and still allows embedded ones', () => {
    // cid: and data: travel inside the message, so they tell the sender nothing.
    expect(imgSrc(mailFrameDoc('<p>hi</p>'))).toBe('data: cid:')
  })

  it('allows remote images once released', () => {
    expect(imgSrc(mailFrameDoc('<p>hi</p>', true))).toBe('http: https: data: cid:')
  })

  it('never allows remote content for plain text', () => {
    expect(imgSrc(textFrameDoc('hello', { fg: '#000', bg: '#fff' }))).toBe('data: cid:')
  })
})

describe('hasRemoteContent', () => {
  it('spots the usual tracking pixel', () => {
    expect(hasRemoteContent('<img src="https://track.example/p.gif?u=42">')).toBe(true)
    expect(hasRemoteContent("<img src='http://x/p.gif'>")).toBe(true)
  })

  it('spots what rewriting <img> alone would miss', () => {
    // These are exactly why the block lives in the CSP, not in the markup.
    expect(hasRemoteContent('<div style="background-image: url(https://x/bg.png)">')).toBe(true)
    expect(hasRemoteContent('<img srcset="https://x/a.png 1x">')).toBe(true)
    expect(hasRemoteContent('<body background="https://x/bg.png">')).toBe(true)
  })

  it('does not flag content carried inside the message', () => {
    expect(hasRemoteContent('<img src="cid:logo@example">')).toBe(false)
    expect(hasRemoteContent('<img src="data:image/png;base64,AAAA">')).toBe(false)
    expect(hasRemoteContent('<p>Just words, and a link to https://example.com</p>')).toBe(false)
  })
})
