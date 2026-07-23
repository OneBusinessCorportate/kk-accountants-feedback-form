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
  LANG_TEXT_KEY,
  templateKey,
  getTemplate,
  manualAssetForCategory,
} from './templates'

export { normalizeContract, normalizeChatLink }

// ---- Language resolution (req 4) -------------------------------------------
//
// Language is a per-company parameter. Priority:
//   1. an explicit stored code (client_telegram_chats.language / kk_company_settings)
//   2. the AM/RU/EN(G) suffix embedded in the chat name (mqa_chats.chat_name)
//   3. default RU (never guess a person, never send in an unknown language blind)
const LANG_CANON = { RU: 'RU', RUS: 'RU', AM: 'AM', HY: 'AM', ARM: 'AM', EN: 'ENG', ENG: 'ENG' }

export function normalizeLanguage(value) {
  if (value == null) return null
  const key = value.toString().trim().toUpperCase()
  return LANG_CANON[key] || null
}

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

// ---- Template rendering -----------------------------------------------------

const MONTHS = {
  RU: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  AM: ['հունվար', 'փետրվար', 'մարտ', 'ապրիլ', 'մայիս', 'հունիս', 'հուլիս', 'օգոստոս', 'սեպտեմբեր', 'հոկտեմբեր', 'նոյեմբեր', 'դեկտեմբեր'],
  ENG: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
}

// period is 'YYYYMM' (mqa convention). Returns a human month name for the lang.
export function monthName(period, language = 'RU') {
  const s = (period || '').toString()
  const mm = Number.parseInt(s.slice(4, 6), 10)
  if (!mm || mm < 1 || mm > 12) return ''
  return (MONTHS[language] || MONTHS.RU)[mm - 1]
}

// Current reporting period as 'YYYYMM', following Margarita's 28th-cutoff cycle
// (from the 28th the period rolls to next month) so it lines up with
// mqa_chat_mailings.period. `now` is passed in (no hidden Date.now()).
export function currentPeriod(now) {
  const d = now ? new Date(now) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  // interpret the wall clock in Asia/Yerevan (UTC+4, no DST)
  const y = new Date(d.getTime() + 4 * 3600 * 1000)
  let year = y.getUTCFullYear()
  let month = y.getUTCMonth() // 0-based
  if (y.getUTCDate() >= 28) {
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }
  return `${year}${String(month + 1).padStart(2, '0')}`
}

// period 'YYYYMM' → 'MM/YYYY' for the реквизиты line.
export function periodLabel(period) {
  const s = (period || '').toString()
  if (s.length < 6) return s
  return `${s.slice(4, 6)}/${s.slice(0, 4)}`
}

// Replace {{key}} tokens. Missing keys collapse to '' so a template never leaks
// a raw placeholder to a client.
export function fillTemplate(text, values = {}) {
  if (text == null) return ''
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    values[k] == null ? '' : String(values[k]),
  )
}

// Build the message body for one planned mailing. `ctx` carries the resolved,
// per-client data (period, amount, due day, month). Returns null for an unknown
// template. This is the auto-composed starting point; an accountant may still
// edit it via the audited button before it goes out.
export function composeMailing({ category, subtype, language, ctx = {} } = {}) {
  const tpl = getTemplate(category, subtype)
  if (!tpl) return null
  const lang = normalizeLanguage(language) || 'RU'
  const body = tpl.text[LANG_TEXT_KEY[lang]] || tpl.text.ru
  const period = ctx.period || ''
  return fillTemplate(body, {
    month: ctx.month || monthName(period, lang),
    period: ctx.periodLabel || periodLabel(period),
    amount: ctx.amount != null && ctx.amount !== '' ? formatAmount(ctx.amount) : '__________',
    due_day: ctx.dueDay || CATEGORY_DEFAULT_DAY[category] || '',
  })
}

export function formatAmount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${n.toLocaleString('ru-RU')} AMD`
}

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

// ---- 30-day planned chain (req 3) ------------------------------------------
//
// Expand each enabled schedule row into concrete dated occurrences between
// `today` and `today + horizonDays`. A schedule row is
// { category, subtype, day_of_month, send_hour, send_minute, enabled }.
// The chain contains AT LEAST one of every enabled category (req 3): if a
// category's monthly day falls outside the window we still surface its next
// occurrence beyond the horizon so the accountant sees the whole chain.
export function expandSchedule(scheduleRows, { today, horizonDays = 30 } = {}) {
  const start = startOfDay(today)
  if (!start) return []
  const end = addDays(start, horizonDays)
  const out = []
  for (const row of scheduleRows || []) {
    if (row.enabled === false) continue
    const hour = row.send_hour ?? 11
    const minute = row.send_minute ?? 0
    let occ = occurrenceOnOrAfter(start, row.day_of_month, hour, minute)
    let within = false
    while (occ <= end) {
      out.push(occurrence(row, occ))
      within = true
      occ = occurrenceOnOrAfter(addMonths(occ, 1), row.day_of_month, hour, minute)
    }
    // guarantee ≥1 of every enabled type even if none fell inside the window
    if (!within) out.push(occurrence(row, occ))
  }
  return out.sort((a, b) => a.scheduledAt - b.scheduledAt)
}

function occurrence(row, when) {
  return {
    category: row.category,
    subtype: row.subtype,
    day_of_month: row.day_of_month,
    scheduledAt: when,
    scheduledISO: when.toISOString(),
  }
}

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

// ---- date helpers (Date math without touching Date.now) --------------------
function startOfDay(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}
function addDays(d, n) {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}
function addMonths(d, n) {
  // Set day to 1 BEFORE shifting the month so e.g. Jan 31 + 1 doesn't overflow
  // into March (occurrenceOnOrAfter re-clamps the day for the target month).
  const c = new Date(d)
  c.setDate(1)
  c.setMonth(c.getMonth() + n)
  return c
}
// The dueDay-th of d's month at hour:minute; clamps to month length.
function occurrenceOnOrAfter(from, dayOfMonth, hour, minute) {
  let year = from.getFullYear()
  let month = from.getMonth()
  const make = (y, m) => {
    const last = new Date(y, m + 1, 0).getDate()
    const day = Math.min(dayOfMonth || 1, last)
    return new Date(y, m, day, hour, minute, 0, 0)
  }
  let occ = make(year, month)
  if (occ < from) {
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
    occ = make(year, month)
  }
  return occ
}

export { MAILING_CATEGORIES, CATEGORY_DEFAULT_DAY }
