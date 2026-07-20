// Supabase Edge Function — quality-report-telegram
//
// Sends the daily / weekly bookkeeping-quality report to the ОК Telegram group
// (task requirement «отчёты присылаются ежедневно и еженедельно … отправка в
// Telegram ОК»). It fetches the SAME data the /reports page shows (kk_problems
// from Margarita + Sona reviews, kk_praise, kk_sona_checks), aggregates it by
// department + accountant, and posts a message via the Telegram Bot API.
//
// The wording mirrors src/lib/telegramReport.js (that pure module is the tested
// spec); the aggregation mirrors src/lib/qualityReport.js. Kept self-contained
// so it runs on Deno without the frontend bundle.
//
// Invoke:  POST /quality-report-telegram?period=daily   (default)
//          POST /quality-report-telegram?period=weekly
//
// Required secrets (set with `supabase secrets set …`, NEVER commit them):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected in Supabase)
//   TELEGRAM_BOT_TOKEN   — the ОК bot token from @BotFather
//   TELEGRAM_CHAT_ID     — the ОК group/chat id (e.g. -1001234567890)
//
// If the Telegram secrets are not present in Deno.env (e.g. when the Supabase
// CLI isn't available to run `secrets set`), they are read from the
// service-role-only `kk_app_secrets` table (migration 0032). Deno.env always
// wins when both are present.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TZ_OFFSET_MIN = 240 // Asia/Yerevan, UTC+4
const SLA_BUSINESS_HOURS: Record<number, number> = { 1: 8, 2: 24, 3: 40 }
const WORK_WINDOWS = [
  [10 * 60, 13 * 60],
  [14 * 60, 19 * 60],
]

function businessHoursBetween(start: string, end: Date): number {
  const s = new Date(start).getTime() + TZ_OFFSET_MIN * 60000
  const e = end.getTime() + TZ_OFFSET_MIN * 60000
  if (!Number.isFinite(s) || e <= s) return 0
  const DAY = 86400000
  let total = 0
  for (let day = Math.floor(s / DAY) * DAY; day < e; day += DAY) {
    for (const [w0, w1] of WORK_WINDOWS) {
      const lo = Math.max(s, day + w0 * 60000)
      const hi = Math.min(e, day + w1 * 60000)
      if (hi > lo) total += (hi - lo) / 60000
    }
  }
  return total / 60
}

function isOverdue(p: any, now: Date): boolean {
  const from = p.detected_at || p.created_at
  if (!from) return false
  const target = SLA_BUSINESS_HOURS[p.priority] ?? SLA_BUSINESS_HOURS[2]
  return businessHoursBetween(from, now) > target
}

// critical = priority 1 AND overdue (the «ОЧЕНЬ СРОЧНО» tier).
function isVeryUrgent(p: any, now: Date): boolean {
  return Number(p.priority) === 1 && isOverdue(p, now)
}

const RESOLVED = new Set(['fixed', 'explained_accepted', 'auto_resolved', 'acknowledged', 'appeal_approved'])

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function periodStart(period: string, now: Date): Date | null {
  if (period === 'weekly') return new Date(now.getTime() - 7 * 86400000)
  // daily → start of the local (Yerevan) day.
  const shifted = now.getTime() + TZ_OFFSET_MIN * 60000
  const DAY = 86400000
  const localMidnight = Math.floor(shifted / DAY) * DAY
  return new Date(localMidnight - TZ_OFFSET_MIN * 60000)
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const period = url.searchParams.get('period') === 'weekly' ? 'weekly' : 'daily'
    const now = new Date()
    const start = periodStart(period, now)
    const afterStart = (d: string | null) => !start || (!!d && new Date(d) >= start)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const [{ data: problems }, { data: praise }, { data: sona }] = await Promise.all([
      supabase.from('kk_problems').select('*').in('source', ['margarita_review', 'sona_review']),
      supabase.from('kk_praise').select('accountant_id, accountant_name, source, detected_at, created_at'),
      supabase.from('kk_sona_checks').select('chat_agr_no, checking_date, record_type'),
    ])

    const scopedProblems = (problems ?? []).filter(
      (p: any) => p.verdict !== 'not_problematic' && afterStart(p.detected_at || p.created_at),
    )
    const scopedPraise = (praise ?? []).filter((p: any) => afterStart(p.detected_at || p.created_at))
    const scopedSona = (sona ?? []).filter((c: any) => afterStart(c.checking_date))

    // Aggregate per accountant.
    const map = new Map<string, any>()
    const row = (r: any) => {
      const key = (r.accountant_id && String(r.accountant_id)) || r.accountant_name || '—'
      if (!map.has(key)) {
        map.set(key, { name: r.accountant_name || '— Не назначено —', issues: 0, urgent: 0, praise: 0 })
      }
      return map.get(key)
    }
    let deptOpen = 0
    const urgent: any[] = []
    for (const p of scopedProblems) {
      const r = row(p)
      r.issues += 1
      if (!RESOLVED.has(p.status)) deptOpen += 1
      if (isVeryUrgent(p, now)) {
        r.urgent += 1
        if (!RESOLVED.has(p.status)) urgent.push(p)
      }
    }
    for (const p of scopedPraise) row(p).praise += 1

    const byAccountant = [...map.values()].sort(
      (a, b) => b.urgent - a.urgent || b.issues - a.issues || b.praise - a.praise,
    )
    urgent.sort(
      (a, b) => +new Date(a.detected_at || a.created_at) - +new Date(b.detected_at || b.created_at),
    )
    const sonaCompanies = new Set(scopedSona.map((c: any) => c.chat_agr_no).filter(Boolean)).size
    const sonaProblems = scopedSona.filter((c: any) => c.record_type === 'problem').length

    // Build the message (mirrors src/lib/telegramReport.js formatQualityReport).
    const periodLabel = period === 'weekly' ? 'за неделю' : 'за сегодня'
    const lines: string[] = []
    lines.push(`<b>📊 Контроль качества бух. услуг — ${periodLabel}</b>`)
    lines.push('')
    lines.push('<b>По отделу</b>')
    lines.push(`• Замечаний: <b>${scopedProblems.length}</b> (открыто ${deptOpen})`)
    lines.push(`• Похвал: <b>${scopedPraise.length}</b>`)
    lines.push(`• Проверено Соной: ${sonaCompanies} (замечаний ${sonaProblems})`)
    if (urgent.length) {
      lines.push('')
      lines.push(`🔴 <b>ОЧЕНЬ СРОЧНО — ${urgent.length}</b>`)
      for (const p of urgent.slice(0, 10)) {
        const who = p.accountant_name ? ` — ${escapeHtml(p.accountant_name)}` : ''
        const client = p.client_name ? ` (${escapeHtml(p.client_name)})` : ''
        lines.push(`• ${escapeHtml(p.problem_title || 'Проблема')}${client}${who}`)
      }
      if (urgent.length > 10) lines.push(`… и ещё ${urgent.length - 10}`)
    }
    if (byAccountant.length) {
      lines.push('')
      lines.push('<b>По бухгалтерам</b>')
      for (const r of byAccountant.slice(0, 15)) {
        const flags = []
        if (r.urgent) flags.push(`🔴${r.urgent}`)
        if (r.issues) flags.push(`⚠️${r.issues}`)
        if (r.praise) flags.push(`👍${r.praise}`)
        lines.push(`• ${escapeHtml(r.name)}: ${flags.join(' ') || '—'}`)
      }
    }
    const text = lines.join('\n')

    // Prefer function secrets (Deno.env); fall back to the service-role-only
    // kk_app_secrets table when the CLI wasn't available to set secrets.
    let token = Deno.env.get('TELEGRAM_BOT_TOKEN')
    let chatId = Deno.env.get('TELEGRAM_CHAT_ID')
    if (!token || !chatId) {
      const { data: secrets } = await supabase
        .from('kk_app_secrets')
        .select('key, value')
        .in('key', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
      for (const s of secrets ?? []) {
        if (s.key === 'TELEGRAM_BOT_TOKEN' && !token) token = s.value as string
        if (s.key === 'TELEGRAM_CHAT_ID' && !chatId) chatId = s.value as string
      }
    }
    if (!token || !chatId) {
      return new Response(JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set', preview: text }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }

    const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
    const tgBody = await tg.json()
    return new Response(JSON.stringify({ ok: tg.ok, period, sent: tgBody }), {
      status: tg.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
})
