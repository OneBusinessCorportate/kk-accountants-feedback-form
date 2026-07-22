// Supabase Edge Function — daily-db-analysis-telegram
//
// Owner ask: «for every day make sure there is the full analysis from supabase
// that is sent in the chat». Every day this posts the department-wide ArmSoft +
// TaxService work analysis (per accountant) to the ОК Telegram group. The SAME
// analysis is shown in-app by src/components/DailyAnalysis.jsx (both use the
// buildDailyAnalysis logic), so «sent in the chat» === «seen here».
//
// The work data lives in the OB Artyom project (a DIFFERENT Supabase project),
// so this function reads it over PostgREST with the Artyom anon key — the same
// views the frontend uses (accounting_activities, accountant_daily_comments).
// The aggregation + wording mirror src/lib/artyomCompare.js (the tested spec).
//
// Invoke: POST /daily-db-analysis-telegram          (today, Asia/Yerevan)
//         POST /daily-db-analysis-telegram?date=2026-07-20
//         POST /daily-db-analysis-telegram?day=yesterday
//
// Required secrets (set with `supabase secrets set …`, NEVER commit them):
//   ARTYOM_SUPABASE_URL       — the OB Artyom project URL
//   ARTYOM_SUPABASE_ANON_KEY  — its anon key (read-only views/RPCs)
//   TELEGRAM_BOT_TOKEN        — the ОК bot token
//   TELEGRAM_CHAT_ID          — the ОК group/chat id
//   NOTICE_SECRET             — (optional) shared secret; if set, callers must
//                               send header x-notice-secret with the same value
//
// Without the TELEGRAM_* secrets it runs "dry": returns the message in the body
// (handy to verify before wiring the bot).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const TZ = "Asia/Yerevan"
const METRICS = ["invoices", "reports", "applications", "balance"] as const
const METRIC_LABELS: Record<string, string> = {
  invoices: "Инвойсы",
  reports: "Отчёты",
  applications: "Заявления",
  balance: "Остатки",
}

type Totals = { invoices: number; reports: number; applications: number; balance: number }

function emptyTotals(): Totals {
  return { invoices: 0, reports: 0, applications: 0, balance: 0 }
}
function addInto(t: Totals, a: any): Totals {
  t.invoices += Number(a.invoices_issued ?? 0)
  t.reports += Number(a.reports_submitted ?? 0)
  t.applications += Number(a.applications_filed ?? 0)
  t.balance += Number(a.balance_changes ?? 0)
  return t
}
function sum(t: Totals): number {
  return t.invoices + t.reports + t.applications + t.balance
}
function diffTotals(tax: Totals, arm: Totals): Totals {
  return {
    invoices: tax.invoices - arm.invoices,
    reports: tax.reports - arm.reports,
    applications: tax.applications - arm.applications,
    balance: tax.balance - arm.balance,
  }
}
function hasDiscrepancy(d: Totals): boolean {
  return METRICS.some((m) => (d[m] ?? 0) !== 0)
}
function normName(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
function fmtNum(n: number): string {
  return Number(n || 0).toLocaleString("ru-RU").replace(/,/g, " ")
}
function fmtDateHuman(d: string): string {
  const [y, m, day] = String(d).slice(0, 10).split("-")
  return `${day}.${m}.${y}`
}
function totalsLine(t: Totals): string {
  return (
    METRICS.filter((m) => (t[m] ?? 0) > 0)
      .map((m) => `${METRIC_LABELS[m]}: ${fmtNum(t[m])}`)
      .join(" · ") || "—"
  )
}

// Mirror of artyomCompare.buildDailyAnalysis (department + per-accountant).
function buildDailyAnalysis(activities: any[], date: string, comments: any[]) {
  const byAcc = new Map<string, { armsoft: Totals; taxservice: Totals; base: Totals }>()
  const compByAcc = new Map<string, Set<string>>()
  const deptArm = emptyTotals(), deptTax = emptyTotals(), deptBase = emptyTotals()
  const companiesAll = new Set<string>()

  for (const a of activities || []) {
    const acc = a.accountant_name || "— без бухгалтера"
    if (!byAcc.has(acc)) {
      byAcc.set(acc, { armsoft: emptyTotals(), taxservice: emptyTotals(), base: emptyTotals() })
      compByAcc.set(acc, new Set())
    }
    const b = byAcc.get(acc)!
    if (a.company_name) {
      compByAcc.get(acc)!.add(normName(a.company_name))
      companiesAll.add(normName(a.company_name))
    }
    if (a.system_source === "armsoft") { addInto(b.armsoft, a); addInto(deptArm, a) }
    else if (a.system_source === "taxservice") { addInto(b.taxservice, a); addInto(deptTax, a) }
    else { addInto(b.base, a); addInto(deptBase, a) }
  }

  const commentsByAcc = new Map<string, any[]>()
  for (const c of comments || []) {
    const acc = c.accountant_name || "— без бухгалтера"
    if (!commentsByAcc.has(acc)) commentsByAcc.set(acc, [])
    commentsByAcc.get(acc)!.push(c)
  }

  const byAccountant = [...byAcc.entries()].map(([accountant, b]) => {
    const total: Totals = {
      invoices: b.armsoft.invoices + b.taxservice.invoices + b.base.invoices,
      reports: b.armsoft.reports + b.taxservice.reports + b.base.reports,
      applications: b.armsoft.applications + b.taxservice.applications + b.base.applications,
      balance: b.armsoft.balance + b.taxservice.balance + b.base.balance,
    }
    const diff = diffTotals(b.taxservice, b.armsoft)
    return {
      accountant, armsoft: b.armsoft, taxservice: b.taxservice, total, diff,
      hasDiscrepancy: hasDiscrepancy(diff),
      companies: compByAcc.get(accountant)?.size || 0,
      comments: commentsByAcc.get(accountant) || [],
    }
  }).sort((x, y) => sum(y.total) - sum(x.total) || x.accountant.localeCompare(y.accountant, "ru"))

  const deptTotal: Totals = {
    invoices: deptArm.invoices + deptTax.invoices + deptBase.invoices,
    reports: deptArm.reports + deptTax.reports + deptBase.reports,
    applications: deptArm.applications + deptTax.applications + deptBase.applications,
    balance: deptArm.balance + deptTax.balance + deptBase.balance,
  }
  const deptDiff = diffTotals(deptTax, deptArm)
  return {
    date,
    department: {
      armsoft: deptArm, taxservice: deptTax, total: deptTotal, diff: deptDiff,
      hasDiscrepancy: hasDiscrepancy(deptDiff),
      accountants: byAccountant.length, companies: companiesAll.size, actions: sum(deptTotal),
    },
    byAccountant,
  }
}

function formatMessage(a: ReturnType<typeof buildDailyAnalysis>, limit = 20): string {
  const d = a.department
  const lines: string[] = []
  lines.push(`📊 <b>Дневной анализ базы (ArmSoft + TaxService)</b>`)
  lines.push(`За день: <b>${esc(fmtDateHuman(a.date))}</b>`)
  lines.push("")
  lines.push(`Бухгалтеров с работой: <b>${d.accountants}</b> · компаний: <b>${d.companies}</b> · действий: <b>${fmtNum(d.actions)}</b>`)
  lines.push(`АрмСофт — ${totalsLine(d.armsoft)}`)
  lines.push(`ТаксСервис — ${totalsLine(d.taxservice)}`)
  if (d.hasDiscrepancy) {
    const gaps = METRICS.filter((m) => (d.diff[m] ?? 0) !== 0)
      .map((m) => `${METRIC_LABELS[m]} ${d.diff[m] > 0 ? "+" : ""}${d.diff[m]}`)
      .join(", ")
    lines.push(`⚠️ Расхождение ТаксСервис−АрмСофт: ${esc(gaps)}`)
  }
  if (a.byAccountant.length) {
    lines.push("")
    lines.push("<b>По бухгалтерам:</b>")
    for (const r of a.byAccountant.slice(0, limit)) {
      const flag = r.hasDiscrepancy ? " ⚠️" : ""
      lines.push(
        `• ${esc(r.accountant)}${flag} — действий ${fmtNum(sum(r.total))} ` +
          `(АС ${fmtNum(sum(r.armsoft))} / ТС ${fmtNum(sum(r.taxservice))}), компаний ${r.companies}`,
      )
    }
    if (a.byAccountant.length > limit) lines.push(`… и ещё ${a.byAccountant.length - limit}`)
  } else {
    lines.push("")
    lines.push("За этот день в базе нет операций.")
  }
  return lines.join("\n")
}

function yerevanToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date())
}

async function artyomSelect(base: string, key: string, path: string): Promise<any[]> {
  const resp = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!resp.ok) throw new Error(`Artyom query failed (${path}): ${resp.status} ${await resp.text()}`)
  return (await resp.json()) as any[]
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<unknown> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  })
  const data = await resp.json()
  if (!resp.ok || !data.ok) throw new Error(`telegram send failed: ${JSON.stringify(data)}`)
  return data
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  try {
    const noticeSecret = Deno.env.get("NOTICE_SECRET")
    if (noticeSecret && req.headers.get("x-notice-secret") !== noticeSecret) {
      return json({ error: "unauthorized" }, 401)
    }

    const artyomUrl = Deno.env.get("ARTYOM_SUPABASE_URL")
    const artyomKey = Deno.env.get("ARTYOM_SUPABASE_ANON_KEY")
    if (!artyomUrl || !artyomKey) {
      return json({ error: "ARTYOM_SUPABASE_URL / ARTYOM_SUPABASE_ANON_KEY not configured" }, 500)
    }

    const url = new URL(req.url)
    let date = url.searchParams.get("date") || ""
    if (!date) {
      date = yerevanToday()
      if (url.searchParams.get("day") === "yesterday") {
        const d = new Date(`${date}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() - 1)
        date = d.toISOString().slice(0, 10)
      }
    }

    const [activities, comments] = await Promise.all([
      artyomSelect(
        artyomUrl, artyomKey,
        `accounting_activities?select=company_name,accountant_name,activity_date,system_source,invoices_issued,reports_submitted,applications_filed,balance_changes&activity_date=eq.${date}`,
      ),
      artyomSelect(
        artyomUrl, artyomKey,
        `accountant_daily_comments?select=accountant_name,company_name,comment_date,comment&comment_date=eq.${date}`,
      ).catch(() => []),
    ])

    const analysis = buildDailyAnalysis(activities, date, comments)
    const message = formatMessage(analysis)

    const token = Deno.env.get("TELEGRAM_BOT_TOKEN")
    const chatId = Deno.env.get("TELEGRAM_CHAT_ID")
    if (!token || !chatId) {
      return json({ sent: false, dry_run: true, date, actions: analysis.department.actions, message })
    }

    const tg = await sendTelegram(token, chatId, message)
    return json({ sent: true, date, actions: analysis.department.actions, message, telegram: tg })
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500)
  }
})
