// Shared labels / option lists used across the app.

export const STATUS = {
  new: 'new',
  waiting_for_accountant: 'waiting_for_accountant',
  submitted_by_accountant: 'submitted_by_accountant',
  in_review: 'in_review',
  fixed: 'fixed',
  explained_accepted: 'explained_accepted',
  returned_to_accountant: 'returned_to_accountant',
  // Terminal status set by kk_ingest_problems() when a live AI detection
  // (no answer / late / promise) is no longer reported by the QA layer — i.e.
  // the chat was answered after we flagged it. Keeps the row for history while
  // dropping it from the accountant/review queues and dashboard counts.
  auto_resolved: 'auto_resolved',
  // Accountant reaction loop (migration 0025):
  //   acknowledged    — accountant clicked «Ознакомлен» (seen & accepted)
  //   appeal_pending  — accountant filed an appeal, awaiting a decision
  //   appeal_approved — appeal upheld → issue dismissed (also verdict
  //                     'not_problematic', so it leaves the dashboard counts)
  //   appeal_rejected — appeal denied → issue stays active/confirmed
  acknowledged: 'acknowledged',
  appeal_pending: 'appeal_pending',
  appeal_approved: 'appeal_approved',
  appeal_rejected: 'appeal_rejected',
}

export const STATUS_LABELS = {
  new: 'Новая',
  waiting_for_accountant: 'Ждёт бухгалтера',
  submitted_by_accountant: 'Отправлена бухгалтером',
  in_review: 'На проверке',
  fixed: 'Исправлено',
  explained_accepted: 'Объяснено / принято',
  returned_to_accountant: 'Возвращена бухгалтеру',
  auto_resolved: 'Снято автоматически (получен ответ)',
  acknowledged: 'Ознакомлен',
  appeal_pending: 'Апелляция на рассмотрении',
  appeal_approved: 'Апелляция одобрена',
  appeal_rejected: 'Апелляция отклонена',
}

// Statuses an accountant is expected to act on. A rejected appeal returns the
// issue to the accountant (it stays active/confirmed — req 9).
export const ACCOUNTANT_ACTIONABLE = [
  STATUS.new,
  STATUS.waiting_for_accountant,
  STATUS.returned_to_accountant,
  STATUS.appeal_rejected,
]

// Statuses a reviewer is expected to act on.
export const REVIEW_QUEUE = [STATUS.submitted_by_accountant, STATUS.in_review]

export const SOURCES = ['ai', 'margarita_review', 'sona_review', 'manual']

export const SOURCE_LABELS = {
  ai: 'AI',
  margarita_review: 'Качество сервиса',
  sona_review: 'Качество бухгалтерской работы',
  manual: 'Вручную',
}

export const PRIORITY_LABELS = {
  1: 'Высокий',
  2: 'Средний',
  3: 'Низкий',
}

// Reviewer's verdict on whether a detected problem was TRULY problematic — the
// learning signal that lets the ingestion filter out false positives.
export const VERDICT = {
  problematic: 'problematic',
  not_problematic: 'not_problematic',
}

export const VERDICT_LABELS = {
  problematic: 'Действительно проблема',
  not_problematic: 'Ложное срабатывание',
}

// Employee roles (from the shared employees table / resolve_login_code) shown
// in the topbar after login. Kept here with the other display labels.
export const ROLE_LABELS = {
  accountant: 'Бухгалтер',
  head_accountant: 'Главный бухгалтер',
  manager: 'Менеджер',
  lawyer: 'Юрист',
  qa: 'QA',
  ceo: 'CEO',
  founder: 'Основатель',
  admin: 'Администратор',
}

// Human label for a role, falling back to the raw value for unknown roles so
// the UI never shows a blank. Matching is case-insensitive / trimmed.
export function roleLabel(role) {
  if (role == null) return ''
  const key = role.toString().trim().toLowerCase()
  return ROLE_LABELS[key] || role
}

// ---- Appeals ---------------------------------------------------------------
//
// An accountant disputes a QA issue (kk_problem_appeals.status). Margarita /
// management then approve or reject it. See migration 0025.
export const APPEAL_STATUS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
}

export const APPEAL_STATUS_LABELS = {
  pending: 'На рассмотрении',
  approved: 'Одобрена',
  rejected: 'Отклонена',
}

export const APPEAL_STATUS_BADGE = {
  pending: 'badge-amber',
  approved: 'badge-green',
  rejected: 'badge-red',
}

// ---- Tasks -----------------------------------------------------------------

export const TASK_TYPES = ['mailing', 'report', 'receipt', 'audit', 'contact', 'qa', 'other']

export const TASK_TYPE_LABELS = {
  mailing: 'Рассылка',
  report: 'Отчёт',
  receipt: 'Квитанция',
  audit: 'Аудит',
  contact: 'Связь с клиентом',
  qa: 'QA-проблема',
  other: 'Другое',
}

export const TASK_TYPE_BADGE = {
  mailing: 'badge-blue',
  report: 'badge-amber',
  receipt: 'badge-green',
  audit: 'badge-gray',
  contact: 'badge-blue',
  qa: 'badge-red',
  other: 'badge-gray',
}

// Task progress state (migration 0025 added kk_tasks.status). The legacy `done`
// boolean is kept in sync (done ⇔ status === 'done').
export const TASK_STATUS = {
  open: 'open',
  in_progress: 'in_progress',
  done: 'done',
}

export const TASK_STATUS_LABELS = {
  open: 'Открыта',
  in_progress: 'В работе',
  done: 'Выполнена',
}

export const TASK_STATUS_BADGE = {
  open: 'badge-blue',
  in_progress: 'badge-amber',
  done: 'badge-green',
}
