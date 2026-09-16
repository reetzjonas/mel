import { describe, expect, it } from 'vitest'
import { percentLabel, quotaLabel, usedFraction } from './quota'

describe('the share of the quota in use', () => {
  it('is the ratio of used to limit', () => {
    expect(usedFraction({ used: 512, limit: 1024 })).toBe(0.5)
  })

  // A server that lets an account overshoot its limit still has to produce a
  // bar that fits in its track.
  it('never exceeds a full bar', () => {
    expect(usedFraction({ used: 2048, limit: 1024 })).toBe(1)
  })

  it('treats an absent limit as empty rather than dividing by zero', () => {
    expect(usedFraction({ used: 10, limit: 0 })).toBe(0)
  })
})

describe('the percentage as shown', () => {
  it('rounds to whole percent', () => {
    expect(percentLabel(0.126)).toBe('13 %')
  })

  // Rounding to "0 %" on an account that has stored something reads as a bug
  // in the meter rather than as a nearly empty account.
  it('keeps a non-empty account from reading as zero', () => {
    expect(percentLabel(0.0001)).toBe('< 1 %')
  })

  it('still says zero when nothing is used', () => {
    expect(percentLabel(0)).toBe('0 %')
  })
})

describe('the figure as shown', () => {
  it('names both numbers', () => {
    expect(quotaLabel({ used: 127_106, limit: 1_073_741_824 })).toBe('124 KB of 1.0 GB used')
  })
})
