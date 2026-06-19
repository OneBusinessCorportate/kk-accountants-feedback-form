// Mapping rules for ingesting problems from the two detection systems into
// `kk_problems`. These are PURE functions — no DB access — so they are easy to
// unit-test and serve as the single, readable spec of the field mapping.
//
// The production ingestion runs entirely inside Postgres
// (`supabase/migrations/0002_problem_ingestion.sql`, function
// `public.kk_ingest_problems()`), because all three systems share one Supabase
// project (OB FAQ). The SQL function applies the SAME rules encoded here; these
// functions are the spec + regression tests, and are reused by the optional
// `scripts/sync-problems.mjs` runner. Keep the two in sync when changing rules.
//
// Sources (Repo A / Repo B), both keyed by the responsible accountant's NAME
// (neither system has a numeric accountant id, so name is the only stable join
// key — we use it for both accountant_name and accountant_id):
//   - Sona  (sona-qa-platform)      → `sqa_tickets`   → source 'sona_review'
//   - Margarita (margarita-qa-platform) → `mqa_violations` → source 'margarita_review'

export const SONA_SOURCE = 'sona_review'
export const MARGARITA_SOURCE = 'margarita_review'

// New problems always land here so they show up in the accountant's queue.
export const INGEST_STATUS = 'waiting_for_accountant'

// First non-empty, trimmed string from the arguments, else null.
function firstText(...values) {
  for (const v of values) {
    if (typeof v === 'string') {
      const t = v.trim()
      if (t !== '') return t
    }
  }
  return null
}

// ---- problem_id derivation -------------------------------------------------
// Each source already has a stable primary key for the problem record, so we
// simply prefix it. Prefixing guarantees the id is globally unique across
// sources, and reusing the source PK guarantees it is stable across re-runs
// (re-ingesting the same record yields the same id → idempotent upsert).

export function sonaProblemId(ticketId) {
  return `${'sona'}:${ticketId}`
}

export function margaritaProblemId(violationId) {
  return `${'margarita'}:${violationId}`
}

// ---- priority mapping (1 = high, 2 = medium, 3 = low) ----------------------

export function sonaPriority({ urgent, priority } = {}) {
  if (urgent || priority === 'critical') return 1
  if (priority === 'medium') return 2
  return 2
}

export function margaritaPriority(severity) {
  if (severity === 'Критичное' || severity === 'Грубое') return 1
  if (severity === 'Среднее') return 2
  return 2
}

// ---- row mappers -----------------------------------------------------------
// Each takes an already-joined, flat row (ticket/violation + the matching
// mqa_chats columns) and returns a kk_problems row ready to upsert.
// They never set fields owned by the accountant workflow beyond the initial
// status, and never touch kk_accountant_feedback.

export function mapSonaTicket(row = {}) {
  const accountant = firstText(row.accountant, row.chat_accountant)
  return {
    problem_id: sonaProblemId(row.id),
    source: SONA_SOURCE,
    client_name: firstText(row.name_agr, row.chat_name),
    contract_id: row.company_agr_no ?? null,
    chat_name: firstText(row.chat_name),
    chat_link: firstText(row.chat_link),
    accountant_name: accountant,
    accountant_id: accountant,
    priority: sonaPriority(row),
    problem_title: firstText(row.title, row.type) || 'Проблема по проверке (Сона)',
    problem_description: firstText(row.description, row.comment),
    ai_comment: firstText(row.comment),
    detected_at: row.created_at ?? null,
    status: INGEST_STATUS,
  }
}

export function mapMargaritaViolation(row = {}) {
  const accountant = firstText(row.accountant, row.chat_accountant)
  return {
    problem_id: margaritaProblemId(row.id),
    source: MARGARITA_SOURCE,
    client_name: firstText(row.client, row.name_agr, row.chat_name),
    contract_id: row.chat_agr_no ?? null,
    chat_name: firstText(row.chat_name),
    chat_link: firstText(row.chat_link),
    accountant_name: accountant,
    accountant_id: accountant,
    priority: margaritaPriority(row.severity),
    problem_title: firstText(row.violation_type) || 'Нарушение (Маргарита)',
    problem_description: firstText(row.note, row.violation_type),
    ai_comment: null,
    detected_at: row.created_at ?? row.vdate ?? null,
    status: INGEST_STATUS,
  }
}

// Columns the idempotent upsert is allowed to refresh on conflict. Notably this
// list EXCLUDES `status` (so an accountant's / reviewer's progress is never
// reset) and contains nothing from kk_accountant_feedback.
export const UPSERT_REFRESH_COLUMNS = [
  'client_name',
  'contract_id',
  'chat_name',
  'chat_link',
  'accountant_name',
  'accountant_id',
  'priority',
  'problem_title',
  'problem_description',
  'ai_comment',
  'detected_at',
]
