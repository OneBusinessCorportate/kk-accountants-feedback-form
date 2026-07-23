#!/usr/bin/env node
/*
 * Template-notifications bot (шаблонные рассылки). Sends planned client mailings
 * via the Telegram Bot API (@onebusiness_agent_bot) and logs each into
 * kk_sent_notifications. TWO HARD SAFETY RULES (see scripts/lib/mailingSafety.mjs):
 *   1. Nothing sends unless ALLOW_SENDING==='true' (default: dry-run preview).
 *   2. FORCE_TEST_CHAT_ONLY forces EVERY send to the test chat -5225180694 — a
 *      real client chat can never receive anything this phase.
 * Modes (--mode): plan (materialise chain) · preview (read-only) · demo-today
 * (5 random active companies, is_test) · send (plan then send, both rules).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
 * TEST_CHAT_ID (default -5225180694), ALLOW_SENDING, DEMO_COUNT.
 */
import { createClient } from '@supabase/supabase-js'
import { FORCED_TEST_CHAT, resolveTarget, canDeliver } from './lib/mailingSafety.mjs'
// Yerevan-anchored schedule math shared with the cabinet (src/lib/notifications.js)
import { occurrenceOnOrAfter, currentPeriod as period } from './lib/schedule.mjs'
// Templates + composition — the SAME module the cabinet uses, so the bot renders
// exactly the previewed text and covers every declared template (no drift).
import { TEMPLATE_LIST, composeMailing } from './lib/templates.mjs'

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

async function telegramSendDocument(chatId, documentUrl, caption) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, document: documentUrl, caption: caption || undefined }),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Telegram(doc): ${json.description || res.status}`)
  return json.result
}

async function deliver({ agrNo, clientName, category, subtype, period, language, text, isTest, docUrl, docName, docRequired }) {
  // RULE 2: the destination is forced to the test chat while the override is on
  // (resolveTarget ignores any client chat id). RULE 1 (+ preview): canDeliver.
  const target = resolveTarget({ forceTestOnly: FORCE_TEST_CHAT_ONLY, clientChatId: null })
  // While the test override is on, every send is a TEST send — it must not
  // consume the real mailing's state (rule 2 / review fix #2).
  const forcedTest = FORCE_TEST_CHAT_ONLY
  const isTestSend = !!isTest || forcedTest
  // The metadata header is for the OPERATOR CONSOLE ONLY — it is never part of
  // the message the client receives (review fix: no header pollution).
  console.log(`\n— [${category}/${subtype} · ${language} · ${clientName || agrNo}] →\n${text}\n`)

  if (!canDeliver({ allowSending: ALLOW_SENDING, previewMode: PREVIEW, target })) {
    console.log(`  · DRY-RUN (preview=${PREVIEW}, allow_sending=${ALLOW_SENDING}) — не отправлено.`)
    return { sent: false, forcedTest }
  }
  if (!BOT_TOKEN) {
    console.log('  · TELEGRAM_BOT_TOKEN не задан — пропуск.')
    return { sent: false, forcedTest }
  }
  // ONE atomic Telegram call so there is no two-step partial failure that could
  // re-send an already-delivered part: a manual-add file is sent with the text
  // as its CAPTION (sendDocument); otherwise the text alone (sendMessage). A
  // required-but-missing file fails the whole delivery (retried next run).
  let result
  try {
    if (docUrl) {
      result = await telegramSendDocument(target, docUrl, text)
    } else if (docRequired) {
      console.warn('  · доставка не выполнена: обязательный файл не приложен.')
      return { sent: false, forcedTest }
    } else {
      result = await telegramSend(target, text)
    }
  } catch (e) {
    console.warn(`  · доставка не выполнена: ${e.message}`)
    return { sent: false, forcedTest }
  }
  if (sb) {
    await sb.from('kk_sent_notifications').insert({
      agr_no: agrNo, client_name: clientName, category, subtype, period, language,
      text, telegram_chat_id: String(target),
      telegram_message_id: result?.message_id ? String(result.message_id) : null,
      is_test: isTestSend,
    })
  }
  console.log(`  · ОТПРАВЛЕНО в тестовый чат ${target} (message_id=${result?.message_id}${docUrl ? ', +файл' : ''}).`)
  return { sent: true, forcedTest, messageId: result?.message_id }
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

// occurrenceOnOrAfter is imported from ./lib/schedule.mjs (Yerevan-anchored,
// returns a UTC instant), shared with the cabinet planner.

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
      const text = composeMailing({ category: s.category, subtype: s.subtype, language, ctx: { period: p } })
      if (text) {
        let status = 'planned'
        if (isCoveredKey(covered, s.agr_no, p, s.category)) status = 'covered'
        else if (manualKind[s.category] && !assetReady(s.agr_no, p, manualKind[s.category])) status = 'awaiting_file'
        rows.push({
          agr_no: s.agr_no, client_name: c.client_name || c.chat_name, chat_name: c.chat_name,
          category: s.category, subtype: s.subtype, period: p, language,
          scheduled_at: occ.toISOString(),
          composed_text: text,
          accountant_id: null, status, is_test: false,
        })
      }
      occ = occurrenceOnOrAfter(new Date(occ.getTime() + 1000), s.day_of_month, s.send_hour ?? 11, s.send_minute ?? 0)
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
  for (const c of ordered) {
    if (picks.length >= DEMO_COUNT) break
    const language = langOf(c)
    // rotate through the declared templates so mailing types differ
    let tpl = TEMPLATE_LIST[picks.length % TEMPLATE_LIST.length]
    for (const t of TEMPLATE_LIST) {
      if (!usedType.has(`${t.category}:${t.subtype}`)) { tpl = t; break }
    }
    const text = composeMailing({ category: tpl.category, subtype: tpl.subtype, language, ctx: { period: p } })
    picks.push({ agrNo: c.agr_no, clientName: c.client_name || c.chat_name, category: tpl.category, subtype: tpl.subtype, period: p, language, text, isTest: true })
    usedType.add(`${tpl.category}:${tpl.subtype}`); usedLang.add(language)
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
  // Idempotency guard (prevents repeats, incl. forced-test polling every 30 min)
  // WITHOUT letting a test send consume the real one:
  //   • a REAL send (is_test=false) blocks the mailing forever (already sent);
  //   • a TEST send (is_test=true) blocks only further sends WHILE the test
  //     override is on — once real sending is enabled, the mailing still goes
  //     out to the client exactly once.
  const sentLog = await selectAll((c) =>
    c.from('kk_sent_notifications').select('agr_no, period, category, is_test'),
  )
  const key = (agrNo, p, cat) => `${normContract(agrNo)}|${p}|${cat}`
  const realSent = new Set(sentLog.filter((s) => !s.is_test).map((s) => key(s.agr_no, s.period, s.category)))
  const testSent = new Set(sentLog.filter((s) => s.is_test).map((s) => key(s.agr_no, s.period, s.category)))
  const isSent = (m) => {
    const k = key(m.agr_no, m.period, m.category)
    return realSent.has(k) || (FORCE_TEST_CHAT_ONLY && testSent.has(k))
  }
  const due = data.filter((m) => !isCoveredKey(covered, m.agr_no, m.period, m.category) && !isSent(m))
  const skipped = data.length - due.length
  // Manual-add categories must ALSO deliver the attached file (salary sheet /
  // tax report). Build a per (agr_no|period|kind) lookup of storage paths.
  const manualKind = { salary: 'salary_sheet', main_taxes: 'tax_report' }
  const assets = await selectAll((c) =>
    c.from('kk_manual_mailing_assets').select('agr_no, period, kind, storage_path'),
  )
  const assetPath = new Map(
    assets.filter((a) => a.storage_path).map((a) => [`${normContract(a.agr_no)}|${a.period}|${a.kind}`, a.storage_path]),
  )
  console.log(`Due mailings: ${due.length} (skipped ${skipped} covered). ${PREVIEW || !ALLOW_SENDING ? 'ПРЕДПРОСМОТР' : 'ОТПРАВКА'} (все → тестовый чат).`)
  for (const m of due) {
    let docUrl = null
    let docName = null
    let docRequired = false
    const kind = manualKind[m.category]
    if (kind) {
      const path = assetPath.get(`${normContract(m.agr_no)}|${m.period}|${kind}`)
      if (path) {
        // A file WAS attached → it must be delivered (fail if we can't).
        docRequired = true
        const { data: signed } = await sb.storage.from('kk-attachments').createSignedUrl(path, 900)
        docUrl = signed?.signedUrl || null
        docName = path.split('/').pop()
      }
      // No path but the mailing is due → the accountant marked it done WITHOUT a
      // file (owner's "mark done" option, req 2): send the text only.
    }
    const r = await deliver({
      agrNo: m.agr_no, clientName: m.client_name, category: m.category,
      subtype: m.subtype, period: m.period, language: m.language, text: m.composed_text, isTest: false,
      docUrl, docName, docRequired,
    })
    // Only advance the REAL mailing state when it was genuinely delivered to the
    // client — a forced test-chat send must NOT mark the real row sent (fix #2).
    if (r.sent && !r.forcedTest) {
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
    // Send-only: the chain is materialised by the nightly `plan` cron. The
    // sender polls frequently (see render.yaml) so a message goes out within
    // the poll interval of its scheduled Yerevan time — not the next morning.
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
