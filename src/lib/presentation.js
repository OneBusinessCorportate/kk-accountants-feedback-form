// Pure presentation helpers shared by the cards. Kept DB-free so they can be
// unit-tested and serve as the spec for how a problem is shown to each role.

import { PRIORITY_LABELS } from './constants'

// Priority badge color by severity: high → red, medium → amber, low → gray.
const PRIORITY_BADGE = { 1: 'badge-red', 2: 'badge-amber', 3: 'badge-gray' }

export function priorityBadgeClass(priority) {
  return PRIORITY_BADGE[priority] || 'badge-blue'
}

export function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] || (priority != null ? String(priority) : '')
}

// The accountant sees a single context block: the human description plus any
// AI / review note, merged. Short, overlapping snippets read better as one.
// NOTE: this deliberately never includes `source` — the accountant should see
// the facts and what to do, not who flagged the problem.
export function problemContext(problem) {
  return [problem.problem_description, problem.ai_comment]
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

// Short ru-RU date for display, or '' when missing / unparseable.
export function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}
