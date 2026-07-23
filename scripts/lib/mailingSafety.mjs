// Safety core for the template-notifications bot — kept in its own tiny,
// dependency-free ESM module so it can be unit-tested (src/lib/mailingSafety.test.js)
// AND imported by scripts/mailing_bot.mjs. These two functions encode the two
// hard rules; changing them changes what the bot is allowed to do.

// Rule 2 anchor: the ONE chat a message may go to during the locked phase.
// This is a hard literal — it is intentionally NOT read from the environment,
// so a stray/typo'd TEST_CHAT_ID env var can never redirect sends elsewhere.
export const FORCED_TEST_CHAT = '-5225180694'

/**
 * Resolve the actual delivery destination.
 * While forceTestOnly is true, the destination is ALWAYS FORCED_TEST_CHAT,
 * regardless of the client's real chat id — a real client chat can never be
 * addressed. When (some day) forceTestOnly is false, the client chat is used.
 */
export function resolveTarget({ forceTestOnly, clientChatId } = {}) {
  if (forceTestOnly) return FORCED_TEST_CHAT
  return clientChatId || null
}

/**
 * May we actually hit the Telegram API right now?
 * Rule 1: never unless allowSending === true. Preview mode is always dry-run
 * even if sending is unlocked. A null/empty destination also blocks.
 */
export function canDeliver({ allowSending, previewMode, target } = {}) {
  if (previewMode) return false
  if (allowSending !== true) return false
  if (!target) return false
  return true
}
