// Cross-app violation workflow (Margarita QA platform ↔ this feedback form).
//
// Margarita's violations live in the QA platform's own tables (mqa_violations /
// mqa_violation_appeals) — the SOURCE OF TRUTH for a violation and where she
// rules on appeals. This app mirrors each violation into kk_problems as
// `problem_id = 'margarita:'<violation id>` (source 'margarita_review', see
// migrations 0002/0022). The accountant's «Ознакомлен»/«Подать апелляцию» on
// such a problem must therefore write back to the mqa_* tables (via the
// SECURITY DEFINER RPCs from migration 0027), and her decision is read back from
// the kk_violation_workflow view — NOT from this app's own kk_problem_* tables.
//
// This module is the pure, DB-free glue: recover the violation id, interpret a
// workflow-view row into a compact UI state. Kept side-effect-free so it is
// unit-tested without a browser or database (see violationWorkflow.test.js).

export const MARGARITA_PREFIX = 'margarita:'

/** Is this kk_problems row a Margarita violation (handled by the mqa_ loop)? */
export function isMargaritaProblem(problem) {
  return (
    problem?.source === 'margarita_review' &&
    typeof problem?.problem_id === 'string' &&
    problem.problem_id.startsWith(MARGARITA_PREFIX)
  )
}

/**
 * Recover the mqa_violations.id from a kk margarita problem_id
 * ('margarita:<id>' → '<id>'). Returns null for anything that isn't a Margarita
 * problem key, so callers never send a bogus id to the RPC.
 */
export function violationIdFromProblemId(problemId) {
  if (typeof problemId !== 'string' || !problemId.startsWith(MARGARITA_PREFIX)) return null
  const id = problemId.slice(MARGARITA_PREFIX.length).trim()
  return id || null
}

// mqa_violations.status vocabulary (kept in sync with the QA platform, repo #1):
//   new | acknowledged | appealed | appeal_approved | appeal_rejected
export const VIOLATION_STATUS_LABELS = {
  new: 'Ожидает вашей реакции',
  acknowledged: 'Вы ознакомились',
  appealed: 'Апелляция на рассмотрении у Маргариты',
  appeal_approved: 'Апелляция одобрена — штраф снят',
  appeal_rejected: 'Апелляция отклонена',
}

export const VIOLATION_STATUS_BADGE = {
  new: 'badge-amber',
  acknowledged: 'badge-gray',
  appealed: 'badge-amber',
  appeal_approved: 'badge-green',
  appeal_rejected: 'badge-red',
}

/**
 * Interpret a kk_violation_workflow view row into the flags the ReactionBox
 * needs. Mirrors the QA platform's own rules (canAcknowledge only on `new`;
 * an appeal may be filed while `new` or `acknowledged`; a decided/appealed
 * violation is read-only for the accountant).
 */
export function interpretWorkflow(row) {
  const status = row?.status || 'new'
  const appealed = status === 'appealed'
  const approved = status === 'appeal_approved'
  const rejected = status === 'appeal_rejected'
  const decided = approved || rejected
  return {
    status,
    label: VIOLATION_STATUS_LABELS[status] || status,
    badge: VIOLATION_STATUS_BADGE[status] || 'badge-gray',
    acknowledged: status === 'acknowledged' || appealed || decided,
    pendingAppeal: appealed,
    decided,
    approved,
    rejected,
    // The accountant may still act only in these states.
    canAcknowledge: status === 'new',
    canAppeal: status === 'new' || status === 'acknowledged',
    appealText: row?.appeal_text || null,
    decisionComment: row?.decision_comment || null,
    appealCreatedAt: row?.appeal_created_at || null,
    resolvedAt: row?.appeal_resolved_at || null,
  }
}

/** Index workflow-view rows by their kk problem_id for O(1) card lookup. */
export function indexWorkflow(rows) {
  const map = new Map()
  for (const r of rows || []) {
    const key = r?.problem_id || (r?.violation_id ? MARGARITA_PREFIX + r.violation_id : null)
    if (key) map.set(key, r)
  }
  return map
}
