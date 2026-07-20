// Aggregations behind the appeals dashboards — the Margarita work report and the
// per-accountant report. Kept pure & DB-free so they can be unit-tested and read
// as the spec; the pages fetch problems + appeals + acknowledgements and pass
// them in. Everything is derived (no separate stats table) to avoid duplicating
// data (req 8).

// Problems that came out of Margarita's manual quality review.
export const MARGARITA_SOURCE = 'margarita_review'

// Statuses that count as resolved for an accountant (no further action needed).
// A rejected appeal is NOT resolved — the issue stays active and comes back to
// the accountant (req 9). `acknowledged` counts as resolved: the accountant has
// reacted and accepted the issue.
export const RESOLVED_STATUSES = new Set([
  'fixed',
  'explained_accepted',
  'auto_resolved',
  'acknowledged',
  'appeal_approved',
])

export function isResolved(status) {
  return RESOLVED_STATUSES.has(status)
}

// Count appeals by status. Works on any appeal subset (all, or one accountant's).
export function summarizeAppeals(appeals = []) {
  return {
    total: appeals.length,
    pending: appeals.filter((a) => a.status === 'pending').length,
    approved: appeals.filter((a) => a.status === 'approved').length,
    rejected: appeals.filter((a) => a.status === 'rejected').length,
  }
}

// Group appeals by the problem they dispute.
export function groupAppealsByProblem(appeals = []) {
  const map = new Map()
  for (const a of appeals) {
    if (!map.has(a.problem_id)) map.set(a.problem_id, [])
    map.get(a.problem_id).push(a)
  }
  return map
}

// Bucket rows by calendar day of `dateField`, newest day first. Used for the
// "breakdown by date/period" (req 1).
export function countByDay(rows = [], dateField = 'created_at') {
  const map = new Map()
  for (const r of rows) {
    const raw = r[dateField]
    if (!raw) continue
    const day = String(raw).slice(0, 10)
    map.set(day, (map.get(day) || 0) + 1)
  }
  return [...map.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

// A violation is "cancelled" once its appeal was approved (the issue is
// dismissed). Everything else is still an active violation.
export function isCancelledViolation(problem) {
  return problem.status === 'appeal_approved'
}

// The fine attached to a ticket (0 when none). Cancelled once the appeal is
// approved (penalty_cancelled) — kept as a number for summing.
export function penaltyOf(problem) {
  const n = Number(problem.penalty_amount)
  return Number.isFinite(n) ? n : 0
}

// One row per accountant with their QA issue / reaction / appeal counts, the
// current status of each issue (req 2), and their violation + fine totals
// (active vs cancelled-after-approved-appeal — req 5). Appeals are attributed
// through the problem they dispute, so counts stay consistent with the list.
export function perAccountantReport({ problems = [], appeals = [], acks = [] } = {}) {
  const ackSet = new Set(acks.map((a) => a.problem_id))
  const appealsByProblem = groupAppealsByProblem(appeals)
  const map = new Map()

  for (const p of problems) {
    const key = p.accountant_id || p.accountant_name || '—'
    if (!map.has(key)) {
      map.set(key, {
        accountantId: p.accountant_id || null,
        accountantName: p.accountant_name || p.accountant_id || '— Не назначено —',
        issues: 0,
        reviewed: 0,
        open: 0,
        appeals: 0,
        approved: 0,
        rejected: 0,
        pending: 0,
        activeViolations: 0,
        cancelledViolations: 0,
        finesActive: 0,
        finesCancelled: 0,
        items: [],
      })
    }
    const row = map.get(key)
    row.issues += 1
    if (!isResolved(p.status)) row.open += 1
    if (ackSet.has(p.problem_id) || p.status === 'acknowledged') row.reviewed += 1

    const cancelled = isCancelledViolation(p)
    if (cancelled) row.cancelledViolations += 1
    else row.activeViolations += 1

    const fine = penaltyOf(p)
    if (fine > 0) {
      if (cancelled || p.penalty_cancelled) row.finesCancelled += fine
      else row.finesActive += fine
    }

    const pa = appealsByProblem.get(p.problem_id) || []
    for (const a of pa) {
      row.appeals += 1
      if (a.status === 'approved') row.approved += 1
      else if (a.status === 'rejected') row.rejected += 1
      else row.pending += 1
    }

    row.items.push({
      problem_id: p.problem_id,
      title: p.problem_title || p.problem_id,
      status: p.status,
      source: p.source,
      client_name: p.client_name || null,
      appeals: pa.length,
      penalty_amount: fine || null,
      penalty_cancelled: !!p.penalty_cancelled,
    })
  }

  return [...map.values()].sort((a, b) => b.issues - a.issues)
}

// ---- Margarita's checked-chats volume (from kk_margarita_checks) -----------
//
// mqa_evaluations rows: one per chat checked per period. "Chats checked" is the
// count of DISTINCT chats; evaluations is the raw row count.

export function summarizeChecks(checks = []) {
  const chats = new Set()
  for (const c of checks) if (c.chat_agr_no) chats.add(c.chat_agr_no)
  return { chatsChecked: chats.size, evaluations: checks.length }
}

// Distinct chats checked per calendar day (of checking_date), newest first.
export function checksByDay(checks = []) {
  const map = new Map()
  for (const c of checks) {
    const day = c.checking_date ? String(c.checking_date).slice(0, 10) : null
    if (!day) continue
    if (!map.has(day)) map.set(day, new Set())
    if (c.chat_agr_no) map.get(day).add(c.chat_agr_no)
  }
  return [...map.entries()]
    .map(([date, set]) => ({ date, count: set.size }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

// Distinct chats checked per accountant, most first.
export function checksByAccountant(checks = []) {
  const map = new Map()
  for (const c of checks) {
    const name = c.accountant_name || '— Не распознан —'
    if (!map.has(name)) map.set(name, new Set())
    if (c.chat_agr_no) map.get(name).add(c.chat_agr_no)
  }
  return [...map.entries()]
    .map(([accountantName, set]) => ({ accountantName, chatsChecked: set.size }))
    .sort((a, b) => b.chatsChecked - a.chatsChecked)
}

// ---- Sona's checked-companies volume (from kk_sona_checks) -----------------
//
// sqa_reviews rows: one per company checked per period. record_type='problem' is
// a raised issue, record_type='other' is a clean check (no problem → positive).
// «Companies checked» is the count of DISTINCT companies.

export function summarizeSonaChecks(checks = []) {
  const companies = new Set()
  let problems = 0
  let clean = 0
  for (const c of checks) {
    if (c.chat_agr_no) companies.add(c.chat_agr_no)
    if (c.record_type === 'problem') problems += 1
    else clean += 1
  }
  return { companiesChecked: companies.size, reviews: checks.length, problems, clean }
}

// Distinct companies checked by Sona per calendar day (of checking_date).
export function sonaChecksByDay(checks = []) {
  const map = new Map()
  for (const c of checks) {
    const day = c.checking_date ? String(c.checking_date).slice(0, 10) : null
    if (!day) continue
    if (!map.has(day)) map.set(day, new Set())
    if (c.chat_agr_no) map.get(day).add(c.chat_agr_no)
  }
  return [...map.entries()]
    .map(([date, set]) => ({ date, count: set.size }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
}

// Per-accountant Sona volume: companies checked, problems raised, clean checks
// and the average accountant score she gave.
export function sonaChecksByAccountant(checks = []) {
  const map = new Map()
  for (const c of checks) {
    const name = c.accountant_name || '— Не распознан —'
    if (!map.has(name)) {
      map.set(name, { accountantName: name, companies: new Set(), problems: 0, clean: 0, scoreSum: 0, scoreN: 0 })
    }
    const row = map.get(name)
    if (c.chat_agr_no) row.companies.add(c.chat_agr_no)
    if (c.record_type === 'problem') row.problems += 1
    else row.clean += 1
    const s = Number(c.score_accountant)
    if (Number.isFinite(s)) {
      row.scoreSum += s
      row.scoreN += 1
    }
  }
  return [...map.values()]
    .map((r) => ({
      accountantName: r.accountantName,
      companiesChecked: r.companies.size,
      problems: r.problems,
      clean: r.clean,
      avgScore: r.scoreN ? Math.round((r.scoreSum / r.scoreN) * 10) / 10 : null,
    }))
    .sort((a, b) => b.companiesChecked - a.companiesChecked)
}

// Sona work report — her analogue of buildWorkReport (req: «отчёт по работе
// Соны»). `checks` are kk_sona_checks rows scoped to the period.
export function buildSonaReport({ checks = [] } = {}) {
  const s = summarizeSonaChecks(checks)
  return {
    ...s,
    checksByDay: sonaChecksByDay(checks),
    byAccountant: sonaChecksByAccountant(checks),
  }
}

// ---- Praise («похвала») ----------------------------------------------------

export function summarizePraise(praise = []) {
  return {
    total: praise.length,
    margarita: praise.filter((p) => p.source === 'margarita_review').length,
    sona: praise.filter((p) => p.source === 'sona_review').length,
  }
}

export function praiseByAccountant(praise = []) {
  const map = new Map()
  for (const p of praise) {
    const key = p.accountant_id || p.accountant_name || '—'
    if (!map.has(key)) map.set(key, { accountantName: p.accountant_name || '—', count: 0 })
    map.get(key).count += 1
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

// Top-level workload figures for Margarita's work report (req 1/2). `problems`
// should already be scoped to her review source(s); `appeals`/`acks` are the
// slices that dispute / acknowledge those issues; `checks` are her per-chat
// scorecards (kk_margarita_checks) scoped to the same period. Everything is
// derived — no stats table.
export function buildWorkReport({ problems = [], appeals = [], acks = [], checks = [] } = {}) {
  const byAccountant = perAccountantReport({ problems, appeals, acks })
  const { chatsChecked, evaluations } = summarizeChecks(checks)
  return {
    chatsChecked,
    evaluations,
    issuesCreated: problems.length,
    acknowledged: acks.length,
    appeals: summarizeAppeals(appeals),
    finesActive: byAccountant.reduce((s, r) => s + r.finesActive, 0),
    finesCancelled: byAccountant.reduce((s, r) => s + r.finesCancelled, 0),
    byAccountant,
    issuesByDay: countByDay(problems, 'detected_at'),
    appealsByDay: countByDay(appeals, 'created_at'),
    checksByDay: checksByDay(checks),
    checksByAccountant: checksByAccountant(checks),
  }
}
