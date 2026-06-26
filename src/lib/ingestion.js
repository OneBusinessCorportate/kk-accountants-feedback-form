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
// Sources (Repo A / Repo B). Neither system has an accountant id — only a short
// localized NAME — so that name is resolved to a real employee (uuid + canonical
// full_name) via resolveAccountant() before it is stored:
//   - Sona  (sona-qa-platform)      → `sqa_tickets`   → source 'sona_review'
//   - Margarita (margarita-qa-platform) → `mqa_violations` → source 'margarita_review'

export const SONA_SOURCE = 'sona_review'
export const MARGARITA_SOURCE = 'margarita_review'

// New problems always land here so they show up in the accountant's queue.
export const INGEST_STATUS = 'waiting_for_accountant'

// ---- accountant identity resolution ---------------------------------------
// The QA sources record the accountant only by a short, localized NAME (e.g.
// the Armenian first name "Օլյա"), which does NOT match the canonical
// employees.full_name ("Olya Accounting"). Per-accountant scoping keys off the
// employee identity, so every source name is translated here to a REAL employee
// (uuid + canonical full_name). A name with no matching employee resolves to
// null on BOTH fields — we never attribute a problem to an invented person.
//
// Keep this in sync with supabase/migrations/0003_accountant_aliases.sql, which
// seeds the same map into the kk_accountant_aliases table used by the in-DB
// ingestion (a contract test asserts the two stay aligned).

export function normalizeAccountant(name) {
  return (name ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
}

// [ source alias, employees.id (uuid), canonical employees.full_name ].
// Bare Armenian first names map to the dedicated "{Name} Accounting" employee;
// an initial (Մ․) disambiguates to the surname. Source labels with no employee
// (e.g. "հանձնված" = "handed over", "Էրիկ", "-") are deliberately absent so
// they resolve to null instead of a fake accountant.
const ACCOUNTANT_ALIAS_ENTRIES = [
  ['Գայանե', 'aac8ac8c-95d8-4327-b89e-8d0ff991de82', 'Gayane Accounting'],
  ['Թագուհի', 'e7d79ff0-1fc6-4e04-ac83-bc3b56a5e7d8', 'Taguhi Accounting'],
  ['Ստելլա', '6e60a1f3-2869-4e02-ba38-d00e6e2edb83', 'Stella Accounting'],
  ['Լիլիթ', '2f1be5af-4da7-43d1-9a04-8945d3238136', 'Lilit Accounting'],
  ['Լիլիթ Ք․', '2f1be5af-4da7-43d1-9a04-8945d3238136', 'Lilit Accounting'],
  ['Նաիրա', 'b2799800-e8bc-4b28-8ce6-db73eb548f3b', 'Naira Accounting'],
  ['Նաիրա Մ․', 'f04c637e-2d94-46d4-85cb-e8e7399835be', 'Naira Mkhitaryan'],
  ['Օլյա', '2b22a577-7683-4f22-9834-c957312da4bc', 'Olya Accounting'],
  ['Հասմիկ', 'bc8f2f14-63bb-4a69-b79f-a69c93441c59', 'Hasmik Accounting'],
  ['Ավագ', '2872d701-7b27-48b4-81f5-e4120fea0d47', 'Avag Accounting'],
  ['Դավիթ', 'db613c42-efa0-4bc9-a267-ccfde1676681', 'Davit Accounting'],
  ['Սաթենիկ', '5f7a5c5e-2f0e-46de-bcd6-ab617e641769', 'Satenik'],
  ['Ռոբերտ', 'f5ccf667-d42e-4b1d-8b9c-79d0f0330e14', 'Rob Accounting'],
  ['Էմիլյա', '7b5f8d9f-689d-4376-b31b-41e1c7b8199f', 'Emiliya Avanesyan'],
  ['Տաթև', '7875fde5-2cb5-44f0-a6b6-29a04c00a912', 'Tatev Accounting'],
  ['Առփինե', 'ce7d90ee-343c-453b-bbed-8da99c237a5c', 'Arpine'],
]

export const ACCOUNTANT_ALIASES = new Map(
  ACCOUNTANT_ALIAS_ENTRIES.map(([alias, id, full]) => [
    normalizeAccountant(alias),
    { employee_id: id, full_name: full },
  ]),
)

// Reverse lookup: employee UUID → canonical full_name (e.g. "Lilit Accounting").
// Used by Clients.jsx to filter ob_accounting_companies without an extra DB query.
const CANONICAL_BY_UUID = new Map(
  ACCOUNTANT_ALIAS_ENTRIES.map(([, id, full]) => [id, full]),
)
export function canonicalNameByUUID(uuid) {
  return CANONICAL_BY_UUID.get(uuid) ?? null
}

/**
 * Resolve a raw source accountant name to { accountant_id, accountant_name }.
 * accountant_id is the employee uuid (so client-side scoping matches), and
 * accountant_name is the canonical full_name. Unknown names → both null.
 */
export function resolveAccountant(rawName) {
  const hit = ACCOUNTANT_ALIASES.get(normalizeAccountant(rawName))
  if (!hit) return { accountant_id: null, accountant_name: null }
  return { accountant_id: hit.employee_id, accountant_name: hit.full_name }
}

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
  const { accountant_id, accountant_name } = resolveAccountant(
    firstText(row.accountant, row.chat_accountant),
  )
  return {
    problem_id: sonaProblemId(row.id),
    source: SONA_SOURCE,
    client_name: firstText(row.name_agr, row.chat_name),
    contract_id: row.company_agr_no ?? null,
    chat_name: firstText(row.chat_name),
    chat_link: firstText(row.chat_link),
    accountant_name,
    accountant_id,
    priority: sonaPriority(row),
    problem_title: firstText(row.title, row.type) || 'Проблема по проверке (Сона)',
    problem_description: firstText(row.description, row.comment),
    ai_comment: firstText(row.comment),
    detected_at: row.created_at ?? null,
    status: INGEST_STATUS,
  }
}

export function mapMargaritaViolation(row = {}) {
  const { accountant_id, accountant_name } = resolveAccountant(
    firstText(row.accountant, row.chat_accountant),
  )
  return {
    problem_id: margaritaProblemId(row.id),
    source: MARGARITA_SOURCE,
    client_name: firstText(row.client, row.name_agr, row.chat_name),
    contract_id: row.chat_agr_no ?? null,
    chat_name: firstText(row.chat_name),
    chat_link: firstText(row.chat_link),
    accountant_name,
    accountant_id,
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

// ---- Live QA detections (qa_* RPCs) ----------------------------------------
// Besides the manual Sona/Margarita reviews above, kk_ingest_problems() also
// ingests the live detections that power the dashboards, so «без ответа»,
// «поздний ответ» and broken promises all appear in the feedback form:
//   qa_unanswered_chats     → 'Без ответа клиенту'
//   qa_answered_late_chats  → 'Поздний ответ клиенту'
//   qa_overdue_promises     → 'Невыполненное обещание (не отправлено)'
// These come from RPCs (no source table), so the production path is SQL
// (migration 0004). The mappers below mirror that SQL for spec + regression
// tests. The accountant is resolved in SQL (kk_resolve_employee, by chat-named
// accountant → employee); here it is passed in as { accountant_id,
// accountant_name } (both null when the RPC names nobody, e.g. promises).

// These are AI-detected, so they use the 'ai' source (see SOURCES/constants).
export const QA_SOURCE = 'ai'

export const QA_PROBLEM_TITLES = {
  unanswered: 'Без ответа клиенту',
  // Uncertain (data_incomplete / needs_review): the staff reply was likely
  // dropped on import or staff is active — surfaced for review, NOT blamed.
  review: 'Возможно без ответа (требует проверки)',
  late: 'Поздний ответ клиенту',
  promise: 'Невыполненное обещание (не отправлено)',
}

// Reverse of QA_PROBLEM_TITLES: classify a STORED problem back to its QA kind
// ('unanswered' | 'late' | 'promise' | 'review' | null). The problem_id PREFIX is
// only the kind at creation time — the message-based reclassification (migration
// 0014) relabels an `unanswered:` row to «Поздний ответ» without (and unable to)
// change its id. So the authoritative current kind is the problem_title; we read
// that first and fall back to the id prefix only when the title is unrecognised.
// Order matters: the review title also contains «без ответа», so it is matched
// before the plain unanswered title.
export function qaKind(problem = {}) {
  const title = (problem.problem_title || '').toString().toLowerCase()
  if (title.includes('поздний ответ')) return 'late'
  if (title.includes('обещание')) return 'promise'
  if (title.includes('требует проверки')) return 'review'
  if (title.includes('без ответа')) return 'unanswered'
  const prefix = (problem.problem_id || '').toString().split(':')[0]
  return ['unanswered', 'late', 'promise', 'review'].includes(prefix) ? prefix : null
}

// An unanswered row is UNCERTAIN when the QA layer couldn't confirm the miss
// (importer likely dropped the staff reply, or staff was recently active). Such
// rows must not be pinned on an accountant who may well have answered.
export function isUnansweredUncertain(item = {}) {
  return Boolean(item.data_incomplete) || Boolean(item.needs_review)
}

// @mentions in a client message, lowercased & de-@'d. These identify WHO was
// actually asked, so a confirmed-unanswered chat is assigned only to them.
export function extractMentions(text) {
  const out = []
  const re = /@([A-Za-z0-9_]+)/g
  let m
  while ((m = re.exec(text || '')) !== null) out.push(m[1].toLowerCase())
  return out
}

const NO_ACCOUNTANT = { accountant_id: null, accountant_name: null }

// Telegram deep link for a chat id (matches the SQL link expression).
export function telegramChatLink(chatId) {
  return chatId == null ? null : `https://web.telegram.org/a/#${chatId}`
}

// Stable, globally-unique problem_id. Unanswered chats get one problem PER
// responsible accountant (so each sees it), hence the optional employee suffix.
export function qaProblemId(kind, chatId, employeeId = null) {
  const base = `${kind}:${chatId}`
  return employeeId ? `${base}:${employeeId}` : base
}

// Unanswered severity → priority (1 high / 2 medium / 3 low). data_incomplete /
// needs-review rows come through as 'minor' → low, never as a critical.
export function unansweredPriority(severity) {
  if (severity === 'critical') return 1
  if (severity === 'minor') return 3
  return 2
}

export function mapUnansweredChat(item = {}, accountant = NO_ACCOUNTANT) {
  return {
    problem_id: qaProblemId('unanswered', item.chat_id, accountant.accountant_id),
    source: QA_SOURCE,
    client_name: firstText(item.chat_name),
    contract_id: null,
    chat_name: firstText(item.chat_name),
    chat_link: telegramChatLink(item.chat_id),
    accountant_name: accountant.accountant_name ?? null,
    accountant_id: accountant.accountant_id ?? null,
    priority: unansweredPriority(item.severity),
    problem_title: QA_PROBLEM_TITLES.unanswered,
    problem_description: firstText(item.problematic_client_message),
    ai_comment: firstText(item.flag_reason),
    detected_at: item.oldest_pending_at ?? null,
    status: INGEST_STATUS,
  }
}

// Uncertain unanswered row → one UNASSIGNED soft problem (nobody blamed). The
// assigned «Без ответа» path (mapUnansweredChat) is used only for confirmed rows.
export function mapUncertainUnanswered(item = {}) {
  return {
    problem_id: qaProblemId('review', item.chat_id),
    source: QA_SOURCE,
    client_name: firstText(item.chat_name),
    contract_id: null,
    chat_name: firstText(item.chat_name),
    chat_link: telegramChatLink(item.chat_id),
    accountant_name: null,
    accountant_id: null,
    priority: 3,
    problem_title: QA_PROBLEM_TITLES.review,
    problem_description: firstText(item.problematic_client_message),
    ai_comment: firstText(item.flag_reason),
    detected_at: item.oldest_pending_at ?? null,
    status: INGEST_STATUS,
  }
}

export function mapLateChat(item = {}, accountant = NO_ACCOUNTANT) {
  return {
    problem_id: qaProblemId('late', item.chat_id),
    source: QA_SOURCE,
    client_name: firstText(item.client_name, item.chat_name),
    contract_id: null,
    chat_name: firstText(item.chat_name),
    chat_link: telegramChatLink(item.chat_id),
    accountant_name: accountant.accountant_name ?? null,
    accountant_id: accountant.accountant_id ?? null,
    priority: 2,
    problem_title: QA_PROBLEM_TITLES.late,
    problem_description: firstText(item.oldest_pending_text),
    ai_comment: firstText(item.flag_reason),
    detected_at: item.request_time ?? null,
    status: INGEST_STATUS,
  }
}

export function mapOverduePromise(item = {}) {
  return {
    problem_id: qaProblemId('promise', item.chat_id),
    source: QA_SOURCE,
    client_name: firstText(item.chat_name),
    contract_id: null,
    chat_name: firstText(item.chat_name),
    chat_link: telegramChatLink(item.chat_id),
    // The RPC names no accountant for promises → stays unassigned (supervisors
    // still see it). Never invent an owner.
    accountant_name: null,
    accountant_id: null,
    priority: 2,
    problem_title: QA_PROBLEM_TITLES.promise,
    problem_description: firstText(item.promise_text),
    ai_comment: firstText(item.flag_reason),
    detected_at: item.promise_time ?? null,
    status: INGEST_STATUS,
  }
}
