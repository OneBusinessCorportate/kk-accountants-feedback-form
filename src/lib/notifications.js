// Pure, DB-free logic for automated template notifications (шаблонные рассылки).
//
// Everything here is deterministic and unit-tested so the cabinet preview, the
// 30-day planner and the sender script all agree on WHAT would be sent and WHEN.
// No network, no Date.now() surprises: callers pass `now`/`today` in.
//
// See templates.js for the message inventory and dashboard.js for the shared
// contract/link normalisers (we must dedup against Margarita's mqa_chat_mailings
// exactly the way the dashboard does).

import { normalizeContract, normalizeChatLink } from './dashboard'
import {
  TEMPLATES,
  TEMPLATE_LIST,
  MAILING_CATEGORIES,
  CATEGORY_DEFAULT_DAY,
  templateKey,
  manualAssetForCategory,
  // language + composition live in the shared template module (bot ↔ cabinet)
  normalizeLanguage,
  composeMailing,
  monthName,
  periodLabel,
  fillTemplate,
  formatAmount,
} from './templates'
// Schedule/period math lives in the shared module so the cabinet and the bot
// agree on Yerevan-anchored send times (see scripts/lib/schedule.mjs).
import { expandSchedule, currentPeriod } from '../../scripts/lib/schedule.mjs'

// Re-export the shared pieces so existing importers/tests of './notifications'
// keep working unchanged.
export {
  normalizeContract, normalizeChatLink, expandSchedule, currentPeriod,
  normalizeLanguage, composeMailing, monthName, periodLabel, fillTemplate, formatAmount,
}

// ---- Language resolution (req 4) -------------------------------------------
//
// Language is a per-company parameter. Priority:
//   1. an explicit stored code (client_telegram_chats.language / kk_company_settings)
//   2. the AM/RU/EN(G) suffix embedded in the chat name (mqa_chats.chat_name)
//   3. default RU (never guess a person, never send in an unknown language blind)

// Pull the language token from a chat name. Names look like
// "B-4701 <…> ИП RU" / "… ՍՊԸ AM" / "… ENG". We look for a standalone token.
export function languageFromChatName(chatName) {
  if (!chatName) return null
  const tokens = chatName.toString().toUpperCase().match(/[A-ZԱ-Ֆ]+/g) || []
  // scan from the end — the language marker is a suffix
  for (let i = tokens.length - 1; i >= 0; i--) {
    const lang = normalizeLanguage(tokens[i])
    if (lang) return lang
  }
  return null
}

export function resolveLanguage({ storedLanguage, chatName } = {}) {
  return normalizeLanguage(storedLanguage) || languageFromChatName(chatName) || 'RU'
}

// ---- Telegram chat id resolution (delivery) --------------------------------
//
// mqa_chats.chat_link embeds the numeric id after '#', e.g.
// "https://web.telegram.org/a/#-5171468893". This mirrors mqa_norm_tg_id /
// normalizeTelegramId from the QA platform so the registry we backfill matches
// the live messages feed. NOTE: the delivery target for the Bot API supergroup
// form may need the -100 prefix (see toBotApiChatId); the raw id is what we store.
export function extractTelegramId(chatLink) {
  if (!chatLink) return null
  const m = chatLink.toString().match(/#(-?\d+)/)
  if (!m) return null
  let s = m[1].replace(/^[-+]/, '')
  if (/^\d+$/.test(s) && s.slice(0, 3) === '100' && s.length >= 13) s = s.slice(3)
  return s || null
}

// Best-effort Bot API chat_id from a stored numeric id. Telegram supergroups
// are addressed as -100<id>. This is only used by the sender for REAL client
// chats (which are locked off in this phase); the test chat is passed verbatim.
export function toBotApiChatId(rawId) {
  if (rawId == null) return null
  const s = rawId.toString().trim()
  if (s.startsWith('-')) return s
  return `-100${s}`
}

// Template rendering (monthName / periodLabel / fillTemplate / composeMailing /
// formatAmount) is imported from the shared template module and re-exported
// above — one implementation for cabinet and bot. currentPeriod likewise comes
// from scripts/lib/schedule.mjs (Yerevan cutoff).

// ---- Auto-send warning (req 3) ---------------------------------------------
// Shown EVERYWHERE a planned message appears, so it's clear it goes out
// automatically and the send time is fixed (not editable).
export function autoSendWarning(scheduledAt, language = 'RU') {
  const when = formatDateTime(scheduledAt)
  const map = {
    RU: `⚠ Это сообщение уйдёт клиенту автоматически ${when}. Отредактировать текст можно до этого времени; изменить время нельзя.`,
    AM: `⚠ Այս հաղորդագրությունն ավտոմատ կուղարկվի հաճախորդին ${when}։ Տեքստը կարելի է խմբագրել մինչ այդ, ժամը փոխել հնարավոր չէ։`,
    ENG: `⚠ This message will be sent to the client automatically at ${when}. You can edit the text until then; the time cannot be changed.`,
  }
  return map[normalizeLanguage(language) || 'RU'] || map.RU
}

export function formatDateTime(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ru-RU', {
    timeZone: 'Asia/Yerevan',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// The 30-day planned chain (req 3) is built by expandSchedule, re-exported from
// scripts/lib/schedule.mjs (Yerevan-anchored, ≥1 of every enabled category).

// ---- Dedup against Margarita's real mailing log (never double-send) --------
//
// mqa_chat_mailings rows are per (agr_no, period, category). If a done/manual
// row already exists for this contract+period+category, the bot must NOT send
// that category again this period (req: never double-send, never override a
// manual send). classifyMailingStatus (dashboard.js) decides done/pending.
export function mailingKey(agrNo, period, category) {
  return `${normalizeContract(agrNo)}|${period}|${category}`
}

// Build a set of "already covered" keys from mailing rows. A mailing counts as
// covered when it was confirmed, sent by a human (source='manual'), or its
// status classifies as done.
export function coveredMailingKeys(mailingRows, classify) {
  const set = new Set()
  for (const m of mailingRows || []) {
    const done =
      m.confirmed === true ||
      m.source === 'manual' ||
      (typeof classify === 'function' && classify(m) === 'done')
    if (done) set.add(mailingKey(m.agr_no, m.period, m.category))
  }
  return set
}

export function isCovered(coveredKeys, agrNo, period, category) {
  return coveredKeys.has(mailingKey(agrNo, period, category))
}

// ---- Manual-asset gating (req 2) -------------------------------------------
// A category whose template needs a file (salary sheet / tax report) is
// "blocked" until that file is attached or explicitly marked done for the
// period. assets = [{ agr_no, period, kind, storage_path, marked_done }].
export function manualAssetReady(assets, agrNo, period, kind) {
  const nk = normalizeContract(agrNo)
  return (assets || []).some(
    (a) =>
      normalizeContract(a.agr_no) === nk &&
      a.period === period &&
      a.kind === kind &&
      (a.marked_done === true || !!a.storage_path),
  )
}

// Combine everything: is this planned occurrence sendable right now?
//   'covered'        — already sent/marked this period (skip, dedup)
//   'awaiting_file'  — needs a manual file that isn't attached yet
//   'ready'          — auto-composable and clear to send at its time
export function sendability({ agrNo, period, category }, { coveredKeys, assets } = {}) {
  if (coveredKeys && isCovered(coveredKeys, agrNo, period, category)) return 'covered'
  const need = manualAssetForCategory(category)
  if (need && !manualAssetReady(assets, agrNo, period, need)) return 'awaiting_file'
  return 'ready'
}

// ---- Demo selection (today-only, test chat) --------------------------------
//
// Pick N active companies with DISTINCT languages and DISTINCT mailing types,
// deterministically given an ordered candidate list (randomness, if any, is
// applied by the caller before passing the list — pure code stays testable).
// Each returned item is a ready-to-compose (company + template + language).
export function pickDemoMailings(candidates, { count = 5 } = {}) {
  const out = []
  const usedLang = new Set()
  const usedType = new Set()
  const templates = TEMPLATE_LIST
  let ti = 0
  for (const c of candidates || []) {
    if (out.length >= count) break
    const language = resolveLanguage({ storedLanguage: c.language, chatName: c.chat_name })
    // rotate through templates so types differ; prefer an unused type/lang
    let tpl = templates[ti % templates.length]
    for (let k = 0; k < templates.length; k++) {
      const cand = templates[(ti + k) % templates.length]
      if (!usedType.has(templateKey(cand.category, cand.subtype))) {
        tpl = cand
        break
      }
    }
    ti++
    out.push({
      agr_no: c.agr_no,
      chat_name: c.chat_name,
      client_name: c.client_name || c.name_agr || c.name_tax || c.chat_name,
      language,
      category: tpl.category,
      subtype: tpl.subtype,
      assembly: tpl.assembly,
    })
    usedLang.add(language)
    usedType.add(templateKey(tpl.category, tpl.subtype))
  }
  return out
}

export { MAILING_CATEGORIES, CATEGORY_DEFAULT_DAY }
