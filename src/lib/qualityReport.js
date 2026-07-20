// Combined quality report — ONE report for the whole department and for each
// accountant, merging every quality signal we have (task requirement:
// «объединить отчёт для бухгалтеров и глав.бух … и отчёт Соны и выдавать один
// отчёт за день по отделу и по каждому бухгалтеру»).
//
// It fuses:
//   * problems  — kk_problems from Margarita + Sona reviews (the tickets)
//   * praise    — kk_praise (positive results — never tickets)
//   * sona / margarita checks — how many companies/chats each reviewer verified
//
// Pure & DB-free (spec + unit-tested); pages fetch the rows and pass them in.
// Period filtering is the caller's job (reuse inPeriod from dashboard.js) so the
// same builder serves Сегодня / Неделя / Месяц etc.

import { isVeryUrgent, urgencyLevel, URGENCY } from './dashboard'
import { isResolved } from './reports'

// Key an accountant consistently across the three datasets (id first, else name).
function accountantKey(row) {
  return (row?.accountant_id && String(row.accountant_id)) || row?.accountant_name || '—'
}

// Build the per-accountant + department quality report.
//   problems       — kk_problems rows (already scoped to review sources + period)
//   praise         — kk_praise rows (scoped to period)
//   sonaChecks     — kk_sona_checks rows (scoped to period)
//   margaritaChecks— kk_margarita_checks rows (scoped to period)
//   now            — injectable clock (urgency/overdue)
export function buildQualityReport({
  problems = [],
  praise = [],
  sonaChecks = [],
  margaritaChecks = [],
  now = new Date(),
} = {}) {
  const map = new Map()
  const row = (r) => {
    const key = accountantKey(r)
    if (!map.has(key)) {
      map.set(key, {
        accountantId: r?.accountant_id || null,
        accountantName: r?.accountant_name || r?.accountant_id || '— Не назначено —',
        issues: 0,
        open: 0,
        urgent: 0,
        praise: 0,
        checkedBySona: 0,
        checkedByMargarita: 0,
        _sonaCompanies: new Set(),
        _margChats: new Set(),
      })
    }
    return map.get(key)
  }

  for (const p of problems) {
    const r = row(p)
    r.issues += 1
    if (!isResolved(p.status)) r.open += 1
    if (isVeryUrgent(p, now)) r.urgent += 1
  }
  for (const p of praise) {
    row(p).praise += 1
  }
  for (const c of sonaChecks) {
    if (c.chat_agr_no) row(c)._sonaCompanies.add(c.chat_agr_no)
  }
  for (const c of margaritaChecks) {
    if (c.chat_agr_no) row(c)._margChats.add(c.chat_agr_no)
  }

  const byAccountant = [...map.values()]
    .map((r) => ({
      accountantId: r.accountantId,
      accountantName: r.accountantName,
      issues: r.issues,
      open: r.open,
      urgent: r.urgent,
      praise: r.praise,
      checkedBySona: r._sonaCompanies.size,
      checkedByMargarita: r._margChats.size,
      // A crude but useful department signal: praise minus problems. Positive =
      // mostly good, negative = needs attention. Shown as «Баланс».
      balance: r.praise - r.issues,
    }))
    .sort((a, b) => b.urgent - a.urgent || b.issues - a.issues || b.praise - a.praise)

  const department = {
    accountants: byAccountant.length,
    issues: problems.length,
    open: byAccountant.reduce((s, r) => s + r.open, 0),
    urgent: byAccountant.reduce((s, r) => s + r.urgent, 0),
    praise: praise.length,
    checkedBySona: new Set(sonaChecks.map((c) => c.chat_agr_no).filter(Boolean)).size,
    checkedByMargarita: new Set(margaritaChecks.map((c) => c.chat_agr_no).filter(Boolean)).size,
  }

  return { department, byAccountant }
}

// The single «что исправить ОЧЕНЬ СРОЧНО» list: top-priority, still-open,
// SLA-breached issues, most-overdue first. Feeds the urgent block of the report
// and the Telegram message.
export function urgentIssues(problems = [], now = new Date()) {
  return problems
    .filter((p) => !isResolved(p.status) && urgencyLevel(p, now) === URGENCY.critical)
    .sort((a, b) => new Date(a.detected_at || a.created_at) - new Date(b.detected_at || b.created_at))
}
