// Sona's marks about accountants, grouped for the management overview.
//
// Sona runs the manual "quality of accounting work" review; every remark she
// makes lands in kk_problems with source `sona_review` (see CLAUDE.md — the
// ingestion of sqa_tickets + ticketless sqa_reviews). Admins / supervisors want
// one screen where they can see, per accountant, every mark Sona gave and — by
// hovering the ⓘ button — the detail of the mistake behind it.
//
// Kept pure & DB-free so it can be unit-tested and read as the spec; the page
// fetches the `sona_review` problems and passes them in.

import { problemContext } from './presentation'

// Problems that came out of Sona's manual accounting-quality review.
export const SONA_SOURCE = 'sona_review'

// A reviewer-confirmed false positive is dropped from accountant queues and
// dashboard counts elsewhere; it should not count against an accountant here
// either. Everything else Sona flagged is a real mark.
export function isDismissed(problem) {
  return problem.verdict === 'not_problematic'
}

// The human detail behind a mark — what the accountant actually did wrong. This
// is exactly what the ⓘ button reveals on hover. Falls back to the title when
// Sona left no description so the tooltip is never empty.
export function markInfo(problem) {
  const detail = problemContext(problem)
  return detail || problem.problem_title || 'Без описания.'
}

// Normalise one `sona_review` problem into a compact mark for the UI.
export function toMark(problem) {
  return {
    problem_id: problem.problem_id,
    title: problem.problem_title || problem.problem_id,
    info: markInfo(problem),
    client_name: problem.client_name || null,
    contract_id: problem.contract_id || null,
    chat_name: problem.chat_name || null,
    chat_link: problem.chat_link || null,
    priority: problem.priority ?? null,
    status: problem.status,
    detected_at: problem.detected_at || problem.created_at || null,
    dismissed: isDismissed(problem),
  }
}

// Group Sona's marks by accountant. Only `sona_review` rows are considered — no
// other source is ever counted here. Each group carries the accountant identity,
// a total and an active (non-dismissed) count, and the individual marks newest
// first. Groups are ordered by active-mark count (most first), then name.
//
// A row with no resolved accountant is kept under a «Не назначено» group so the
// mark is never silently lost, but we never guess an owner (mirrors the rest of
// the app — see scope.js / dashboard.js).
export function groupSonaMarks(problems = []) {
  const sona = problems.filter((p) => p.source === SONA_SOURCE)
  const map = new Map()

  for (const p of sona) {
    const key = p.accountant_id || p.accountant_name || '—'
    if (!map.has(key)) {
      map.set(key, {
        accountantId: p.accountant_id || null,
        accountantName: p.accountant_name || p.accountant_id || '— Не назначено —',
        total: 0,
        active: 0,
        marks: [],
      })
    }
    const group = map.get(key)
    const mark = toMark(p)
    group.total += 1
    if (!mark.dismissed) group.active += 1
    group.marks.push(mark)
  }

  for (const group of map.values()) {
    group.marks.sort((a, b) => {
      const da = new Date(a.detected_at || 0).getTime()
      const db = new Date(b.detected_at || 0).getTime()
      return db - da
    })
  }

  return [...map.values()].sort((a, b) => {
    if (b.active !== a.active) return b.active - a.active
    return a.accountantName.localeCompare(b.accountantName, 'ru')
  })
}

// Top-line totals for the header (accountants marked, total & active marks).
export function summarizeSonaMarks(groups = []) {
  return {
    accountants: groups.length,
    total: groups.reduce((s, g) => s + g.total, 0),
    active: groups.reduce((s, g) => s + g.active, 0),
  }
}
