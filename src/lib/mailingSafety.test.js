import { describe, it, expect } from 'vitest'
import { FORCED_TEST_CHAT, resolveTarget, canDeliver } from '../../scripts/lib/mailingSafety.mjs'

// The two hard safety rules of the mailing bot. If any of these fail, the bot
// could deliver to a real client chat — do NOT weaken them.
describe('mailing bot safety core', () => {
  it('forces the test chat regardless of the client chat id (rule 2)', () => {
    expect(resolveTarget({ forceTestOnly: true, clientChatId: '-1001234567890' })).toBe(FORCED_TEST_CHAT)
    expect(resolveTarget({ forceTestOnly: true, clientChatId: null })).toBe(FORCED_TEST_CHAT)
    expect(FORCED_TEST_CHAT).toBe('-5225180694')
  })

  it('uses the client chat only when the override is explicitly off', () => {
    expect(resolveTarget({ forceTestOnly: false, clientChatId: '-100999' })).toBe('-100999')
  })

  it('never delivers unless sending is explicitly allowed (rule 1)', () => {
    expect(canDeliver({ allowSending: false, previewMode: false, target: FORCED_TEST_CHAT })).toBe(false)
    expect(canDeliver({ allowSending: undefined, previewMode: false, target: FORCED_TEST_CHAT })).toBe(false)
    expect(canDeliver({ allowSending: 'true', previewMode: false, target: FORCED_TEST_CHAT })).toBe(false) // must be boolean true
  })

  it('preview mode is always dry-run even when sending is unlocked', () => {
    expect(canDeliver({ allowSending: true, previewMode: true, target: FORCED_TEST_CHAT })).toBe(false)
  })

  it('delivers only with allowSending===true, not preview, and a target', () => {
    expect(canDeliver({ allowSending: true, previewMode: false, target: FORCED_TEST_CHAT })).toBe(true)
    expect(canDeliver({ allowSending: true, previewMode: false, target: null })).toBe(false)
  })
})
