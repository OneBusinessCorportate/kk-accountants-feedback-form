// Telegram report text builder (task requirement: «отчёты присылаются ежедневно
// и еженедельно … настроить отправку отчёта в телеграм ОК»).
//
// Pure & DB-free so it can be unit-tested and read as the spec for the message
// the Supabase Edge Function (supabase/functions/quality-report-telegram) sends.
// The edge function does the fetching + aggregation and the actual HTTP POST to
// the Telegram Bot API; this module owns ONLY the wording/formatting so the exact
// text is testable without a network.
//
// Output is Telegram HTML (parse_mode=HTML): <b>…</b> is honoured, everything
// else must be plain text with &lt; / &amp; escaped.

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function plural(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

// Interpret the department numbers into a single verdict so the message never
// reads as "all good" just because it is empty. Owner rule: NO activity is
// itself bad (no QA checks, no ticket reviews) — a green «всё хорошо» must appear
// ONLY when checks were actually done AND nothing is left open. Worst → best:
//   no_control — 0 проверок за период (никто не контролировал)  → red
//   urgent     — есть критичные «ОЧЕНЬ СРОЧНО»                   → red
//   open       — есть неустранённые замечания                    → orange
//   resolved   — замечания были, но все закрыты                  → yellow
//   clean      — проверки были, замечаний нет                    → green (единственное «хорошо»)
export function reportVerdict(department = {}) {
  const checkedBySona = department.checkedBySona ?? 0
  const checkedByMargarita = department.checkedByMargarita ?? 0
  const totalChecks = checkedBySona + checkedByMargarita
  const open = department.open ?? 0
  const urgent = department.urgent ?? 0
  const issues = department.issues ?? 0

  if (totalChecks === 0) {
    return {
      key: 'no_control',
      head: '🔴',
      emoji: '⛔️',
      title: 'контроль качества НЕ проводился',
      note: 'За период не зафиксировано ни одной проверки. Это плохо: тикеты не проверялись, качество никто не контролировал.',
    }
  }
  if (urgent > 0) {
    return {
      key: 'urgent',
      head: '🔴',
      emoji: '🔴',
      title: 'есть критичные замечания — ОЧЕНЬ СРОЧНО',
      note: `Открытых замечаний: ${open}, из них критичных: ${urgent} — исправить немедленно.`,
    }
  }
  if (open > 0) {
    return {
      key: 'open',
      head: '🟠',
      emoji: '🟠',
      title: 'есть открытые замечания',
      note: `Открытых замечаний: ${open} — нужно закрыть.`,
    }
  }
  if (issues > 0) {
    return {
      key: 'resolved',
      head: '🟡',
      emoji: '🟡',
      title: 'замечания были и устранены',
      note: `Все ${issues} ${plural(issues, 'замечание закрыто', 'замечания закрыты', 'замечаний закрыты')}.`,
    }
  }
  return {
    key: 'clean',
    head: '🟢',
    emoji: '🟢',
    title: 'проверки проведены, замечаний нет',
    note: `Проверено ${totalChecks}, открытых замечаний нет.`,
  }
}

// Build the daily / weekly department report message.
//   periodLabel  — «за сегодня» | «за неделю» | …
//   dateLabel    — human date/range string (formatted by the caller)
//   report       — buildQualityReport() output ({ department, byAccountant })
//   urgent       — urgentIssues() output (kk_problems rows)
//   sona         — buildSonaReport() output (or null)
//   topN         — how many accountants to list (default 12)
export function formatQualityReport({
  periodLabel = 'за период',
  dateLabel = '',
  report = { department: {}, byAccountant: [] },
  urgent = [],
  sona = null,
  topN = 12,
} = {}) {
  const d = report.department || {}
  const v = reportVerdict(d)
  const lines = []

  // Header colour follows the verdict, so the very first glyph tells the state.
  lines.push(`${v.head} <b>Контроль качества бух. услуг — ${escapeHtml(periodLabel)}</b>`)
  if (dateLabel) lines.push(escapeHtml(dateLabel))
  lines.push('')

  // The verdict line — this is what stops an empty day looking «хорошо».
  lines.push(`${v.emoji} <b>ИТОГ: ${escapeHtml(v.title)}</b>`)
  lines.push(escapeHtml(v.note))
  lines.push('')

  // Department summary. A reviewer with 0 checks is marked ❌ so an empty source
  // is always visibly bad, never a neutral zero.
  const sona0 = (d.checkedBySona ?? 0) === 0 ? ' ❌' : ''
  const marg0 = (d.checkedByMargarita ?? 0) === 0 ? ' ❌' : ''
  const open = d.open ?? 0
  const issues = d.issues ?? 0
  lines.push('<b>По отделу</b>')
  lines.push(`• Проверки: Сона ${d.checkedBySona ?? 0}${sona0}, Маргарита ${d.checkedByMargarita ?? 0}${marg0}`)
  lines.push(`• Открытых замечаний: <b>${open}</b>${open > 0 ? ' 🔴' : ''}`)
  lines.push(`• Замечаний всего: ${issues}${issues > 0 ? ` (устранено ${issues - open})` : ''}`)
  lines.push(`• 🔴 ОЧЕНЬ СРОЧНО: ${d.urgent ?? 0}`)
  lines.push(`• Похвал: ${d.praise ?? 0}`)

  // The «ОЧЕНЬ СРОЧНО» detail — first after the summary when non-empty.
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

  // Per-accountant table (compact).
  const rows = (report.byAccountant || []).slice(0, topN)
  if (rows.length) {
    lines.push('')
    lines.push('<b>По бухгалтерам</b>')
    for (const r of rows) {
      const flags = []
      if (r.urgent) flags.push(`🔴${r.urgent}`)
      if (r.issues) flags.push(`⚠️${r.issues}`)
      if (r.praise) flags.push(`👍${r.praise}`)
      lines.push(`• ${escapeHtml(r.accountantName)}: ${flags.join(' ') || '—'}`)
    }
  }

  if (sona) {
    lines.push('')
    const n = sona.companiesChecked ?? 0
    lines.push(
      `<b>Работа Соны:</b> проверено ${n} ${plural(n, 'компания', 'компании', 'компаний')}` +
        ` (замечаний ${sona.problems ?? 0}, без замечаний ${sona.clean ?? 0})`,
    )
  }

  return lines.join('\n')
}

// Convenience wrappers naming the cadence.
export function formatDailyReport(args = {}) {
  return formatQualityReport({ periodLabel: 'за сегодня', ...args })
}

export function formatWeeklyReport(args = {}) {
  return formatQualityReport({ periodLabel: 'за неделю', ...args })
}
