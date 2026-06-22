// Shared labels / option lists used across the app.

export const STATUS = {
  new: 'new',
  waiting_for_accountant: 'waiting_for_accountant',
  submitted_by_accountant: 'submitted_by_accountant',
  in_review: 'in_review',
  fixed: 'fixed',
  explained_accepted: 'explained_accepted',
  returned_to_accountant: 'returned_to_accountant',
}

export const STATUS_LABELS = {
  new: 'Новая',
  waiting_for_accountant: 'Ждёт бухгалтера',
  submitted_by_accountant: 'Отправлена бухгалтером',
  in_review: 'На проверке',
  fixed: 'Исправлено',
  explained_accepted: 'Объяснено / принято',
  returned_to_accountant: 'Возвращена бухгалтеру',
}

// Statuses an accountant is expected to act on.
export const ACCOUNTANT_ACTIONABLE = [
  STATUS.new,
  STATUS.waiting_for_accountant,
  STATUS.returned_to_accountant,
]

// Statuses a reviewer is expected to act on.
export const REVIEW_QUEUE = [STATUS.submitted_by_accountant, STATUS.in_review]

export const SOURCES = ['ai', 'margarita_review', 'sona_review', 'manual']

export const SOURCE_LABELS = {
  ai: 'AI',
  margarita_review: 'Качество сервиса',
  sona_review: 'Качество бухгалтерии',
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
