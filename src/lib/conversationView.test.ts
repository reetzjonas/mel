import { beforeEach, describe, expect, it } from 'vitest'
import { conversationView, setConversationView } from './conversationView'

describe('the conversation-view preference', () => {
  beforeEach(() => localStorage.clear())

  /*
   * "Nothing stored" has to mean "never touched it", not "off". The value is
   * only ever written by the settings toggle, so reading a missing key as
   * off would silently ungroup every mailbox on a fresh device.
   */
  it('is on until somebody turns it off', () => {
    expect(conversationView()).toBe(true)
  })

  it('remembers either answer', () => {
    setConversationView(false)
    expect(conversationView()).toBe(false)
    setConversationView(true)
    expect(conversationView()).toBe(true)
  })

  it('treats an unrecognised stored value as on, like a missing one', () => {
    // Only the exact string 'off' turns it off; debris from an older format
    // must not silently change the view.
    localStorage.setItem('mel:conversations', 'nonsense')
    expect(conversationView()).toBe(true)
  })
})
