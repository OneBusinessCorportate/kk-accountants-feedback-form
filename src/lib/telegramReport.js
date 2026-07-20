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
  const lines = []

  lines.push(`<b>📊 Контроль качества бух. услуг — ${escapeHtml(periodLabel)}</b>`)
  if (dateLabel) lines.push(escapeHtml(dateLabel))
  lines.push('')

  // Department summary.
  lines.push('<b>По отделу</b>')
  lines.push(`• Замечаний: <b>${d.issues ?? 0}</b> (открыто ${d.open ?? 0})`)
  lines.push(`• Похвал: <b>${d.praise ?? 0}</b>`)
  lines.push(
    `• Проверено: Сона ${d.checkedBySona ?? 0}, Маргарита ${d.checkedByMargarita ?? 0}`,
  )

  // The «ОЧЕНЬ СРОЧНО» block — always first when non-empty.
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
