import { describe, expect, it } from 'vitest'
import { MAX_EDGE, photoBox } from './photo'

describe('the box a picked picture is drawn into', () => {
  it('keeps the aspect ratio of a wide image', () => {
    expect(photoBox(1000, 500)).toEqual({ width: 256, height: 128 })
  })

  it('keeps the aspect ratio of a tall image', () => {
    expect(photoBox(500, 1000)).toEqual({ width: 128, height: 256 })
  })

  // The card carries the picture itself, so the point is to make it smaller;
  // blowing a tiny image up would only make the stored card bigger.
  it('never scales up', () => {
    expect(photoBox(48, 48)).toEqual({ width: 48, height: 48 })
  })

  it('leaves at least one pixel of a very lopsided image', () => {
    expect(photoBox(4000, 3).height).toBe(1)
  })

  it('has nothing to draw for an empty image', () => {
    expect(photoBox(0, 0)).toEqual({ width: 0, height: 0 })
  })

  it('caps the long edge at what an avatar can show', () => {
    const box = photoBox(4000, 2000)
    expect(Math.max(box.width, box.height)).toBe(MAX_EDGE)
  })
})
