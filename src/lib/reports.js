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

// One row per accountant with their QA issue / reaction / appeal counts and the
// current status of each of their issues (req 2). Appeals are attributed through
// the problem they dispute, so counts stay consistent with the issue list.
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
        items: [],
      })
    }
    const row = map.get(key)
    row.issues += 1
    if (!isResolved(p.status)) row.open += 1
    if (ackSet.has(p.problem_id) || p.status === 'acknowledged') row.reviewed += 1

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
    })
  }

  return [...map.values()].sort((a, b) => b.issues - a.issues)
}

// Top-level workload figures for Margarita's work report (req 1). `problems`
// should already be scoped to her review source(s); `appeals`/`acks` are the
// slices that dispute / acknowledge those issues.
export function buildWorkReport({ problems = [], appeals = [], acks = [] } = {}) {
  return {
    issuesCreated: problems.length,
    acknowledged: acks.length,
    appeals: summarizeAppeals(appeals),
    byAccountant: perAccountantReport({ problems, appeals, acks }),
    issuesByDay: countByDay(problems, 'detected_at'),
    appealsByDay: countByDay(appeals, 'created_at'),
  }
}
