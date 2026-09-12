import { beforeEach, describe, expect, it } from 'vitest'
import { imagePolicy, setImagePolicy } from './imagePolicy'

/*
 * A remote image is a network request to the sender the moment a message is
 * displayed — that is how read receipts and IP disclosure work in mail. So
 * the default is not a matter of taste, and these pin it: anything other than
 * an explicit "always" has to come back as "ask".
 */
describe('the remote-image policy', () => {
  beforeEach(() => localStorage.clear())

  it('asks when nothing has been decided', () => {
    expect(imagePolicy()).toBe('ask')
  })

  it('loads without asking only after an explicit yes', () => {
    setImagePolicy('always')
    expect(imagePolicy()).toBe('always')
    setImagePolicy('ask')
    expect(imagePolicy()).toBe('ask')
  })

  it('falls back to asking on a value it does not recognise', () => {
    // Debris from an older format, or a hand-edited entry: it must not be
    // read as permission.
    localStorage.setItem('mel:images', 'yes')
    expect(imagePolicy()).toBe('ask')
    localStorage.setItem('mel:images', 'ALWAYS')
    expect(imagePolicy()).toBe('ask')
  })
})
