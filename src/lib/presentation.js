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

// A raw diagnostic flag token (snake_case, e.g. `no_staff_reply_after_client_question`).
// It's redundant with the problem title, so we never show it to the accountant.
function isTechnicalFlag(text) {
  return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(text)
}

// The accountant sees a single context block: the human description plus any
// AI / review note, merged. Short, overlapping snippets read better as one.
// NOTE: this deliberately never includes `source` — the accountant should see
// the facts and what to do, not who flagged the problem — nor the raw detection
// flag, which only duplicates the title.
export function problemContext(problem) {
  return [problem.problem_description, problem.ai_comment]
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t && !isTechnicalFlag(t))
    .join('\n\n')
}

// Short ru-RU date for display, or '' when missing / unparseable.
export function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

// ---- Aging / SLA -----------------------------------------------------------
// A triage queue lives and dies by how fast the oldest / most urgent items get
// picked up, so we surface how long each problem has been waiting and flag the
// ones past their response target.

// Whole days between `value` and `now` (>= 0), or null when unparseable.
export function daysSince(value, now = new Date()) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const ms = now.getTime() - d.getTime()
  if (ms <= 0) return 0
  return Math.floor(ms / 86400000)
}

// Russian plural for "день" (1 день / 2 дня / 5 дней).
function pluralDays(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня'
  return 'дней'
}

// Human age of a problem: 'сегодня' / 'вчера' / 'N дней назад'.
export function formatAge(value, now = new Date()) {
  const days = daysSince(value, now)
  if (days == null) return ''
  if (days === 0) return 'сегодня'
  if (days === 1) return 'вчера'
  return `${days} ${pluralDays(days)} назад`
}

// Target first-response window per priority (high reacts fastest).
export const SLA_DAYS = { 1: 1, 2: 3, 3: 7 }

// A still-open problem is overdue once it has waited past its priority target.
export function isOverdue(problem, now = new Date()) {
  const days = daysSince(problem.detected_at || problem.created_at, now)
  if (days == null) return false
  const limit = SLA_DAYS[problem.priority] ?? 3
  return days >= limit
}

// Triage order: highest priority first, then the oldest waiting first. Pure —
// returns a new array and never mutates the input.
export function sortQueue(problems) {
  return [...problems].sort((a, b) => {
    const pa = a.priority ?? 99
    const pb = b.priority ?? 99
    if (pa !== pb) return pa - pb
    const da = new Date(a.detected_at || a.created_at || 0).getTime()
    const db = new Date(b.detected_at || b.created_at || 0).getTime()
    return da - db
  })
}
