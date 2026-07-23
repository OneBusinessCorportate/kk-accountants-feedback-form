#!/usr/bin/env node
/*
 * Template-notifications bot (шаблонные рассылки).
 *
 * Sends the planned client mailings automatically via the Telegram Bot API
 * (@onebusiness_agent_bot) and logs every send into kk_sent_notifications.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  TWO HARD SAFETY RULES (do not remove without an explicit owner decision):
 *
 *  1. SENDING LOCK. Nothing is ever sent unless ALLOW_SENDING === 'true'.
 *     Default is preview/dry-run: the message is composed and printed only.
 *
 *  2. TEST-CHAT-ONLY OVERRIDE. While FORCE_TEST_CHAT_ONLY is true, EVERY send
 *     is redirected to TEST_CHAT_ID (-5225180694) regardless of the client's
 *     real chat. A real client chat can NEVER receive a message in this phase.
 *     Flip to per-client delivery only after the owner says so AND the numeric
 *     chat_id registry + bot membership are verified (see docs).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Modes (MODE env or --mode):
 *   preview      (default) — build today's due mailings, print, never send.
 *   demo-today            — the owner's demo: 5 random ACTIVE companies, mixed
 *                           languages + mixed mailing types, "break the schedule
 *                           only today". Preview unless sending is unlocked;
 *                           logged with is_test=true (never written to mqa).
 *   send                  — send today's due mailings (guarded by both rules).
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (service role: writes the log)
 *   TELEGRAM_BOT_TOKEN                        (@onebusiness_agent_bot)
 *   TEST_CHAT_ID       default -5225180694
 *   ALLOW_SENDING      'true' to actually send (default: off → dry-run)
 *   DEMO_COUNT         default 5
 */
import { createClient } from '@supabase/supabase-js'
import { FORCED_TEST_CHAT, resolveTarget, canDeliver } from './lib/mailingSafety.mjs'

// ---- HARD SAFETY CONSTANTS --------------------------------------------------
const FORCE_TEST_CHAT_ONLY = true // rule 2 — never send to a real client chat
// The forced destination is the HARD LITERAL from mailingSafety (not env), so a
// stray TEST_CHAT_ID can never redirect sends. Env only relabels the log line.
const TEST_CHAT_ID = FORCED_TEST_CHAT
const ALLOW_SENDING = process.env.ALLOW_SENDING === 'true' // rule 1

const MODE = (argFlag('--mode') || process.env.MODE || 'preview').toLowerCase()
const PREVIEW = MODE === 'preview' // preview is ALWAYS dry-run, even if unlocked
const DEMO_COUNT = Number(process.env.DEMO_COUNT || 5)

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''

const sb = SUPABASE_URL && SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY) : null

// ---- Minimal template mirror (canonical source: src/lib/templates.js) ------
// Kept compact for the standalone bot; must stay in sync with templates.js.
const T = {
  primary_docs_request: {
    RU: (m) => `Уважаемые коллеги!\nДля своевременного составления отчётности просим предоставить информацию за ${m} (счета/инвойсы, импорт-экспорт, банковские выписки, данные по зарплате, ВНЖ/Work Permit). Заранее благодарим!`,
    AM: (m) => `Հարգելի գործընկերներ։\nՀաշվետվության ժամանակին կազմման համար խնդրում ենք տրամադրել ${m} ամսվա տեղեկատվությունը (հաշիվներ, ներմուծում/արտահանում, բանկային քաղվածքներ, աշխատավարձ, ВНЖ/Work Permit)։ Կանխավ շնորհակալություն։`,
    ENG: (m) => `Dear colleagues,\nFor the timely preparation of reports, please provide the information for ${m} (invoices, import/export docs, bank statements, payroll data, TRC/Work Permit). Thank you in advance!`,
  },
  debts_service_payment: {
    RU: (m, p) => `ДЛЯ СДАЧИ ОТЧЁТНОСТИ И НАЛОГОВОЙ ОПТИМИЗАЦИИ\nОплатите бухгалтерские услуги до 5 числа (за ${p}). Реквизиты: р/с 1930097970708600 (AMD), Converse Bank, Business Tech LLC, ИНН 02909907, назначение: payment for accountant service.\nПосле оплаты продолжаем работу в полном объёме. Спасибо!`,
    AM: (m, p) => `ՀԱՇՎԵՏՎՈՒԹՅԱՆ ԵՎ ՀԱՐԿԱՅԻՆ ՕՊՏԻՄԱԼԱՑՄԱՆ ՀԱՄԱՐ\nԿատարեք վճարումը մինչև ամսի 5-ը (${p})։ Հ/հ 1930097970708600 (AMD), Converse Bank, Business Tech LLC, ՀՎՀՀ 02909907։\nՎճարումից հետո շարունակում ենք աշխատանքը։ Շնորհակալություն։`,
    ENG: (m, p) => `FOR REPORT SUBMISSION AND TAX OPTIMIZATION\nPlease pay for accounting services by the 5th (for ${p}). Details: acct 1930097970708600 (AMD), Converse Bank, Business Tech LLC, TIN 02909907, purpose: payment for accountant service.\nAfter payment we continue in full. Thank you!`,
  },
  salary_table: {
    RU: () => `Добрый день!\nНаправляю таблицу по заработным платам, также сообщаю, что оплаты проставлены в банке.`,
    AM: () => `Բարի օր։\nՈւղարկում եմ աշխատավարձերի աղյուսակը, ինչպես նաև տեղեկացնում եմ, որ վճարումները նշվել են բանկում։`,
    ENG: () => `Good day,\nI am sending the salary table and confirm the payments have been entered in the bank system.`,
  },
  main_taxes_report: {
    RU: () => `Добрый день!\nОтчёт подготовлен и сдан. Следующим сообщением направляю PDF отчёта и расчёт налогов. Налоги выставлены в банке, прошу подтвердить оплаты.`,
    AM: () => `Բարի օր։\nՀաշվետվությունը պատրաստ է և ներկայացված։ Հաջորդ հաղորդագրությամբ կուղարկեմ PDF-ը և հարկերի հաշվարկը։ Խնդրում եմ հաստատել վճարումները։`,
    ENG: () => `Good day,\nThe report has been prepared and submitted. Next I will send the PDF and the tax calculation. Taxes are in the bank; please approve the payments.`,
  },
}
const DEMO_ORDER = ['primary_docs_request', 'debts_service_payment', 'salary_table', 'main_taxes_report']
const CAT_OF = {
  primary_docs_request: ['primary_docs', 'request'],
  debts_service_payment: ['debts', 'service_payment'],
  salary_table: ['salary', 'table'],
  main_taxes_report: ['main_taxes', 'report'],
}
const MONTHS = {
  RU: ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'],
  AM: ['հունվար','փետրվար','մարտ','ապրիլ','մայիս','հունիս','հուլիս','օգոստոս','սեպտեմբեր','հոկտեմբեր','նոյեմբեր','դեկտեմբեր'],
  ENG: ['January','February','March','April','May','June','July','August','September','October','November','December'],
}
function monthName(p, lang) {
  return (MONTHS[lang] || MONTHS.RU)[Number(p.slice(4, 6)) - 1]
}

function argFlag(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
function langFromName(name) {
  const up = (name || '').toUpperCase()
  if (/\bENG?\b/.test(up)) return 'ENG'
  if (/\b(AM|HY|ARM)\b/.test(up)) return 'AM'
  if (/\b(RU|RUS)\b/.test(up)) return 'RU'
  return null
}
function period(now) {
  const y = new Date(now.getTime() + 4 * 3600 * 1000)
  let year = y.getUTCFullYear(), month = y.getUTCMonth()
  if (y.getUTCDate() >= 28) { month += 1; if (month > 11) { month = 0; year += 1 } }
  return `${year}${String(month + 1).padStart(2, '0')}`
}

async function telegramSend(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Telegram: ${json.description || res.status}`)
  return json.result
}

async function deliver({ agrNo, clientName, category, subtype, language, text, isTest }) {
  // RULE 2: the destination is forced to the test chat while the override is on
  // (resolveTarget ignores any client chat id). RULE 1 (+ preview): canDeliver.
  const target = resolveTarget({ forceTestOnly: FORCE_TEST_CHAT_ONLY, clientChatId: null })
  const header = `— [${category}/${subtype} · ${language} · ${clientName || agrNo}] →\n`
  console.log(`\n${header}${text}\n`)

  if (!canDeliver({ allowSending: ALLOW_SENDING, previewMode: PREVIEW, target })) {
    console.log(`  · DRY-RUN (preview=${PREVIEW}, allow_sending=${ALLOW_SENDING}) — не отправлено.`)
    return { sent: false }
  }
  if (!BOT_TOKEN) {
    console.log('  · TELEGRAM_BOT_TOKEN не задан — пропуск.')
    return { sent: false }
  }
  const result = await telegramSend(target, `${header}${text}`)
  if (sb) {
    await sb.from('kk_sent_notifications').insert({
      agr_no: agrNo, client_name: clientName, category, subtype, language,
      text, telegram_chat_id: String(target),
      telegram_message_id: result?.message_id ? String(result.message_id) : null,
      is_test: !!isTest,
    })
  }
  console.log(`  · ОТПРАВЛЕНО в тестовый чат ${target} (message_id=${result?.message_id}).`)
  return { sent: true, messageId: result?.message_id }
}

// PostgREST caps a select at ~1000 rows; paginate so plan/dedup never silently
// truncate (707 companies × 4 schedule rows = 2828, mailings > 3000).
async function selectAll(build, pageSize = 1000) {
  const out = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(sb).range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    out.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return out
}

async function activeCompanies() {
  if (!sb) return []
  return selectAll((c) =>
    c.from('kk_company_settings').select('agr_no, client_name, chat_name, language, active').eq('active', true),
  )
}

function normContract(v) {
  return (v || '').toString().replace(/№\s*/g, '').replace(/В/g, 'B').replace(/Н/g, 'N').toUpperCase().replace(/\s+/g, '')
}

// Dedup source of truth: (agr_no|period|category) already done or sent by hand.
// Mirrors coveredMailingKeys/classifyMailingStatus (src/lib/*). We never
// double-send and never override a manual send.
async function loadCoveredKeys() {
  if (!sb) return new Set()
  const data = await selectAll((c) =>
    c.from('mqa_chat_mailings').select('agr_no, period, category, status, confirmed, source'),
  )
  const done = /(получ|отправ|нет долга|отправил|получил)/i
  const neg = /(не отправ|не получ|запрос|предстоящ|написал|позвонил)/i
  const set = new Set()
  for (const m of data || []) {
    const s = (m.status || '').toString().trim().toLowerCase()
    const isDone = m.confirmed === true || m.source === 'manual' || (done.test(s) && !neg.test(s))
    if (isDone) set.add(`${normContract(m.agr_no)}|${m.period}|${m.category}`)
  }
  return set
}
function isCoveredKey(covered, agrNo, p, category) {
  return covered.has(`${normContract(agrNo)}|${p}|${category}`)
}

// day-of-month occurrence on/after `from` (clamped to month length)
function occurrenceOnOrAfter(from, day, hour, minute) {
  const make = (y, m) => {
    const last = new Date(y, m + 1, 0).getDate()
    return new Date(y, m, Math.min(day || 1, last), hour, minute, 0, 0)
  }
  let occ = make(from.getFullYear(), from.getMonth())
  if (occ < from) {
    const d = new Date(from.getFullYear(), from.getMonth(), 1)
    d.setMonth(d.getMonth() + 1)
    occ = make(d.getFullYear(), d.getMonth())
  }
  return occ
}

// Materialise the 30-day chain into kk_planned_mailings (service role) so the
// bot's send path has rows to send even for un-edited (normal auto) mailings.
// Skips covered (dedup) and marks manual-file categories awaiting_file.
async function runPlan() {
  if (!sb) { console.log('Supabase не настроен.'); return }
  const now = new Date()
  const horizon = new Date(now); horizon.setDate(horizon.getDate() + 30)
  const companies = await activeCompanies()
  const byContract = new Map(companies.map((c) => [normContract(c.agr_no), c]))
  const covered = await loadCoveredKeys()
  const sched = await selectAll((c) =>
    c.from('kk_mailing_schedule')
      .select('agr_no, category, subtype, day_of_month, send_hour, send_minute, enabled')
      .eq('enabled', true),
  )
  const assets = await selectAll((c) =>
    c.from('kk_manual_mailing_assets').select('agr_no, period, kind, storage_path, marked_done'),
  )
  const assetReady = (agrNo, p, kind) =>
    (assets || []).some((a) => normContract(a.agr_no) === normContract(agrNo) && a.period === p && a.kind === kind && (a.marked_done || a.storage_path))
  const manualKind = { salary: 'salary_sheet', main_taxes: 'tax_report' }

  const rows = []
  for (const s of sched || []) {
    const c = byContract.get(normContract(s.agr_no))
    if (!c) continue
    const language = c.language || langFromName(c.chat_name) || 'RU'
    let occ = occurrenceOnOrAfter(now, s.day_of_month, s.send_hour ?? 11, s.send_minute ?? 0)
    while (occ <= horizon) {
      const p = period(occ)
      const key = `${s.category}_${s.subtype}`
      const render = T[key]?.[language] || T[key]?.RU
      if (render) {
        let status = 'planned'
        if (isCoveredKey(covered, s.agr_no, p, s.category)) status = 'covered'
        else if (manualKind[s.category] && !assetReady(s.agr_no, p, manualKind[s.category])) status = 'awaiting_file'
        rows.push({
          agr_no: s.agr_no, client_name: c.client_name || c.chat_name, chat_name: c.chat_name,
          category: s.category, subtype: s.subtype, period: p, language,
          scheduled_at: occ.toISOString(),
          composed_text: render(monthName(p, language), `${p.slice(4, 6)}/${p.slice(0, 4)}`),
          accountant_id: null, status, is_test: false,
        })
      }
      const n = new Date(occ.getFullYear(), occ.getMonth(), 1); n.setMonth(n.getMonth() + 1)
      occ = occurrenceOnOrAfter(n, s.day_of_month, s.send_hour ?? 11, s.send_minute ?? 0)
    }
  }
  // NEVER clobber an accountant-edited row (status='edited' or 'sent').
  const existing = await selectAll((c) =>
    c.from('kk_planned_mailings')
      .select('agr_no, category, subtype, period, status')
      .eq('is_test', false)
      .in('status', ['edited', 'sent']),
  )
  const locked = new Set(existing.map((e) => `${normContract(e.agr_no)}|${e.category}|${e.subtype}|${e.period}`))
  const upsertable = rows.filter((r) => !locked.has(`${normContract(r.agr_no)}|${r.category}|${r.subtype}|${r.period}`))
  let planned = 0
  const CHUNK = 500
  for (let i = 0; i < upsertable.length; i += CHUNK) {
    const batch = upsertable.slice(i, i + CHUNK)
    const { error } = await sb
      .from('kk_planned_mailings')
      .upsert(batch, { onConflict: 'agr_no,category,subtype,period,is_test', ignoreDuplicates: false })
    if (error) { console.warn(`  · batch upsert error: ${error.message}`); break }
    planned += batch.length
  }
  console.log(`Materialised ${planned}/${rows.length} planned rows (skipped ${locked.size} edited/sent; covered/awaiting_file marked).`)
}

async function runDemoToday() {
  const now = new Date()
  const p = period(now)
  const companies = await activeCompanies()
  // shuffle (randomness only at runtime, not in the tested pure lib)
  for (let i = companies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[companies[i], companies[j]] = [companies[j], companies[i]]
  }
  // Prefer bringing in a NEW language on each pick so the demo shows different
  // languages/chats/types (falls back to any once each language is represented).
  const langOf = (c) => c.language || langFromName(c.chat_name) || 'RU'
  const ordered = []
  const seenLang = new Set()
  for (const c of companies) {
    const l = langOf(c)
    if (!seenLang.has(l)) { ordered.push(c); seenLang.add(l) }
  }
  for (const c of companies) if (!ordered.includes(c)) ordered.push(c)

  const picks = []
  const usedType = new Set()
  const usedLang = new Set()
  const periodLbl = `${p.slice(4, 6)}/${p.slice(0, 4)}`
  for (const c of ordered) {
    if (picks.length >= DEMO_COUNT) break
    const language = langOf(c)
    // rotate template type to vary the mailing types
    let key = DEMO_ORDER[picks.length % DEMO_ORDER.length]
    for (const k of DEMO_ORDER) if (!usedType.has(k)) { key = k; break }
    const [category, subtype] = CAT_OF[key]
    const render = T[key][language] || T[key].RU
    const text = render(monthName(p, language), periodLbl)
    picks.push({ agrNo: c.agr_no, clientName: c.client_name || c.chat_name, category, subtype, language, text, isTest: true })
    usedType.add(key); usedLang.add(language)
  }
  console.log(`\n=== ДЕМО (только сегодня, только тестовый чат ${TEST_CHAT_ID}) ===`)
  console.log(`Период ${p}. Компаний: ${picks.length}. Языки: ${[...usedLang].join(', ')}.`)
  console.log(ALLOW_SENDING ? 'Режим: ОТПРАВКА в тестовый чат.' : 'Режим: ПРЕДПРОСМОТР (отправка на паузе).')
  let sent = 0
  for (const m of picks) {
    const r = await deliver(m)
    if (r.sent) sent++
  }
  console.log(`\nИтог: подготовлено ${picks.length}, отправлено ${sent}.`)
}

async function runSendDue() {
  if (!sb) { console.log('Supabase не настроен.'); return }
  const now = new Date().toISOString()
  const data = await selectAll((c) =>
    c.from('kk_planned_mailings')
      .select('id, agr_no, client_name, category, subtype, period, language, composed_text, status, scheduled_at')
      .lte('scheduled_at', now)
      .eq('is_test', false)
      .in('status', ['planned', 'edited']),
  )
  // Re-check dedup at send time: a manual send may have landed after planning.
  const covered = await loadCoveredKeys()
  const due = data.filter((m) => !isCoveredKey(covered, m.agr_no, m.period, m.category))
  const skipped = data.length - due.length
  console.log(`Due mailings: ${due.length} (skipped ${skipped} covered). ${PREVIEW || !ALLOW_SENDING ? 'ПРЕДПРОСМОТР' : 'ОТПРАВКА'} (все → тестовый чат).`)
  for (const m of due) {
    const r = await deliver({
      agrNo: m.agr_no, clientName: m.client_name, category: m.category,
      subtype: m.subtype, language: m.language, text: m.composed_text, isTest: false,
    })
    if (r.sent) {
      // Needs the service role to actually update (kk_planned_mailings is
      // select-only for anon). Report if the row wasn't flipped so we don't
      // silently re-send on the next run.
      const { data: upd, error: ue } = await sb
        .from('kk_planned_mailings').update({ status: 'sent' }).eq('id', m.id).select('id')
      if (ue || !upd?.length) {
        console.warn(`  · ВНИМАНИЕ: не удалось пометить ${m.id} как sent (нужен service role). Возможен повтор.`)
      }
    }
  }
}

async function main() {
  console.log(`mailing_bot: mode=${MODE} allow_sending=${ALLOW_SENDING} preview=${PREVIEW} test_chat_only=${FORCE_TEST_CHAT_ONLY}`)
  if (MODE === 'demo-today') {
    await runDemoToday()
  } else if (MODE === 'plan') {
    await runPlan()
  } else if (MODE === 'send') {
    await runPlan() // materialise the chain first, then send what's due
    await runSendDue()
  } else {
    // preview — read-only: show what's already due, never writes, never sends
    await runSendDue()
  }
}

main().catch((e) => {
  console.error('mailing_bot error:', e.message)
  process.exit(1)
})
