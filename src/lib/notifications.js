// Pure, DB-free helpers for the templated client-notifications UI. Mirrors the
// QA-platform spec (repo #1 src/lib/notifications.ts): status semantics, the
// «this WILL be sent» warning, category/mode labels, and the by-day grouping the
// manager daily overview needs. Kept side-effect free so it is unit-tested
// without a browser or DB (see notifications.test.js).

// The exact wording flip: the platform PLANS the messages, the accountant may
// edit/attach, and if they do nothing the bot sends on schedule.
export const WILL_SEND_WARNING =
  'Это сообщение БУДЕТ отправлено клиенту ботом автоматически по расписанию. ' +
  'Отредактируйте, приложите документ или отмените — иначе оно уйдёт как есть.'

// Category labels (reuse the mailing taxonomy wording used across the platform).
export const NOTIFICATION_CATEGORY_LABELS = {
  main_taxes: 'Налоги (до 15)',
  salary: 'Зарплата (до 10)',
  primary_docs: 'Первичка (до 28)',
  debts: 'Оплата услуг / долги (до 5)',
}

export function categoryLabel(category) {
  return NOTIFICATION_CATEGORY_LABELS[category] ?? category ?? '—'
}

// AUTO = bot sends fixed wording; MANUAL = needs a file/mark first.
export const NOTIFICATION_MODE_LABELS = {
  auto: 'Автоматически',
  manual: 'Ручная (нужен файл)',
}

export function modeLabel(mode) {
  return NOTIFICATION_MODE_LABELS[mode] ?? mode ?? '—'
}

export const NOTIFICATION_STATUS_LABELS = {
  planned: 'Запланировано',
  edited: 'Изменено',
  approved: 'Подтверждено',
  cancelled: 'Отменено',
  sent: 'Отправлено',
  skipped: 'Пропущено',
}

export const NOTIFICATION_STATUS_BADGE = {
  planned: 'badge-blue',
  edited: 'badge-amber',
  approved: 'badge-green',
  cancelled: 'badge-gray',
  sent: 'badge-green',
  skipped: 'badge-gray',
}

export function statusBadge(status) {
  return NOTIFICATION_STATUS_BADGE[status] ?? 'badge-gray'
}

export function statusLabel(status) {
  return NOTIFICATION_STATUS_LABELS[status] ?? status ?? '—'
}

// planned/edited/approved rows will still be sent by the bot; the rest will not.
export function isSendable(status) {
  return status === 'planned' || status === 'edited' || status === 'approved'
}

// Will THIS planned row actually go out? (status allows it) — status only.
export function willBeSent(row) {
  return !!row && isSendable(row.status)
}

// Will the bot ACTUALLY send this row on schedule? A manual row still missing
// its required attachment is held back by the sender, so it is NOT "will be
// sent" even though its status is sendable. This mirrors the sender's
// sendDecision() gate so the UI never claims a held item will go out.
export function willActuallySend(row, attachment) {
  return !!row && isSendable(row.status) && !needsAttachment(row, attachment)
}

// Build the attachment-lookup key used to pair a planned row with its
// (contract, period, category) attachment row.
export function attachmentKey(row) {
  return `${row.agr_no}|${row.period}|${row.category}`
}

// A manual row that still needs a file/mark before the bot will send it. Used to
// nudge the accountant and to explain why an item is "held".
export function needsAttachment(row, attachment) {
  if (!row || row.mode !== 'manual' || !row.requires_attachment) return false
  const done = !!attachment && (!!attachment.file_url || attachment.marked_done === true)
  return !done
}

// Group planned notifications by scheduled day for the manager daily overview
// (pt.5). Returns [{ date, rows }] sorted ascending by date; each rows[] sorted
// by contract then category for a stable read.
export function groupByDay(planned = []) {
  const byDay = new Map()
  for (const row of planned) {
    const date = (row.scheduled_date ?? '').slice(0, 10)
    if (!date) continue
    if (!byDay.has(date)) byDay.set(date, [])
    byDay.get(date).push(row)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, rows]) => ({
      date,
      rows: rows.slice().sort((x, y) => {
        const c = String(x.agr_no).localeCompare(String(y.agr_no))
        return c !== 0 ? c : String(x.category).localeCompare(String(y.category))
      }),
    }))
}

// Count of notifications that will ACTUALLY go out on a given day — a manual row
// still missing its attachment is excluded (it would be held by the sender). If
// no attachment map is supplied, manual rows requiring one are treated as held.
export function sendableCount(rows = [], attByKey = new Map()) {
  return rows.filter((r) => willActuallySend(r, attByKey.get(attachmentKey(r)))).length
}
