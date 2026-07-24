import { supabase } from './supabaseClient'
import { artyom } from './artyomClient'
import { STATUS } from './constants'
import { qaKind } from './ingestion'
import { getStoredCode } from './auth'
import { violationIdFromProblemId } from './violationWorkflow'

// Small helper so callers get a clean error message instead of a raw object.
function unwrap({ data, error }) {
  if (error) throw new Error(error.message)
  return data
}

// ---- Problems --------------------------------------------------------------

export async function fetchProblems(filters = {}) {
  let query = supabase.from('kk_problems').select('*').order('created_at', { ascending: false })

  if (filters.accountantId) query = query.eq('accountant_id', filters.accountantId)
  if (filters.statusIn?.length) query = query.in('status', filters.statusIn)
  if (filters.source) query = query.eq('source', filters.source)
  if (filters.sourceIn?.length) query = query.in('source', filters.sourceIn)
  // Non-AI sources (Margarita/Sona reviews) are shown regardless of age;
  // AI-detected items (unanswered chats, etc.) are capped at the since window.
  if (filters.since) query = query.or(`source.neq.ai,created_at.gte.${filters.since}`)

  return unwrap(await query)
}

// kk-soprovozhdeniya (mqa_chats) is the source of truth for chat activity. We
// only need enough to tell active from inactive and to match a problem to a
// chat (by link or contract number). Used by the dashboard to hide inactive
// chats. Kept anon-read; select just the three columns we need.
export async function fetchChats() {
  return unwrap(await supabase.from('kk_chat_directory').select('agr_no, chat_link, status'))
}

// Margarita's mailing log (рассылки) — the real record of whether a client
// mailing was done, keyed by contract + period + category. Exposed read-only
// via the kk_chat_mailings view (migration 0024).
export async function fetchMailings() {
  return unwrap(
    await supabase.from('kk_chat_mailings').select('agr_no, period, category, status, confirmed'),
  )
}

// Margarita's approved daily report (mqa_published_reports), shown to
// accountants instead of the retired PDF. Exposed read-only via the
// kk_published_reports view (migration 0033). Returns the LATEST approved report
// (by published_at), or null when nothing has been published yet.
export async function fetchLatestPublishedReport() {
  const rows = unwrap(
    await supabase
      .from('kk_published_reports')
      .select('id, title, body, report_date, period_label, published_by, published_at')
      .order('published_at', { ascending: false })
      .limit(1),
  )
  return rows?.[0] ?? null
}

// Margarita's per-chat quality scorecards (mqa_evaluations), the true record of
// how many chats she actually checked. Exposed read-only via the
// kk_margarita_checks view (migration 0026). One row per checked chat/period
// with the resolved accountant, powering «Объём работы Маргариты» (chats
// checked, by day / by accountant).
export async function fetchMargaritaChecks() {
  return unwrap(
    await supabase
      .from('kk_margarita_checks')
      .select('chat_agr_no, checking_date, quality_band, accountant_name, accountant_id'),
  )
}

// Sona's per-review scorecards (sqa_reviews), the true record of how many
// companies she actually checked. Exposed read-only via the kk_sona_checks view
// (migration 0030). Powers «Объём работы Соны» (checked / by day / by
// accountant) — the Sona analogue of fetchMargaritaChecks.
export async function fetchSonaChecks() {
  return unwrap(
    await supabase
      .from('kk_sona_checks')
      .select(
        'id, chat_agr_no, checking_date, period, record_type, score_accountant, risk_level, report_type, efficiency_pct, accountant_name, accountant_id',
      ),
  )
}

// Positive QA results («похвала») — good Margarita evaluations + clean Sona
// reviews. Additive to kk_problems: never a ticket, only counted in reports and
// shown as encouragement. Read-only from kk_praise (migration 0030).
export async function fetchPraise(filters = {}) {
  let query = supabase.from('kk_praise').select('*').order('detected_at', { ascending: false })
  if (filters.accountantId) query = query.eq('accountant_id', filters.accountantId)
  if (filters.source) query = query.eq('source', filters.source)
  return unwrap(await query)
}

export async function fetchProblemById(problemId) {
  return unwrap(
    await supabase.from('kk_problems').select('*').eq('problem_id', problemId).single(),
  )
}

// Distinct accountants for the filter dropdown.
export async function fetchAccountants() {
  const rows = unwrap(
    await supabase
      .from('kk_problems')
      .select('accountant_id, accountant_name')
      .not('accountant_id', 'is', null),
  )
  const map = new Map()
  for (const r of rows) {
    if (r.accountant_id && !map.has(r.accountant_id)) {
      map.set(r.accountant_id, r.accountant_name || r.accountant_id)
    }
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }))
}

export async function createProblem(problem) {
  return unwrap(await supabase.from('kk_problems').insert(problem).select().single())
}

async function updateProblemStatus(problemId, status) {
  return unwrap(
    await supabase
      .from('kk_problems')
      .update({ status })
      .eq('problem_id', problemId)
      .select()
      .single(),
  )
}

// ---- Accountant feedback ---------------------------------------------------

export async function fetchFeedback(problemId) {
  return unwrap(
    await supabase
      .from('kk_accountant_feedback')
      .select('*')
      .eq('problem_id', problemId)
      .order('submitted_at', { ascending: false }),
  )
}

// Save accountant feedback and move the problem into the review queue.
export async function submitAccountantFeedback({
  problemId,
  accountantId,
  accountantName,
  situationComment,
  solutionComment,
}) {
  const feedback = unwrap(
    await supabase
      .from('kk_accountant_feedback')
      .insert({
        problem_id: problemId,
        accountant_id: accountantId,
        accountant_name: accountantName,
        situation_comment: situationComment,
        solution_comment: solutionComment,
      })
      .select()
      .single(),
  )

  await updateProblemStatus(problemId, STATUS.submitted_by_accountant)
  return feedback
}

// ---- Review actions --------------------------------------------------------

export async function fetchReviewActions(problemId) {
  return unwrap(
    await supabase
      .from('kk_review_actions')
      .select('*')
      .eq('problem_id', problemId)
      .order('created_at', { ascending: false }),
  )
}

// Record a reviewer action and update the problem status accordingly.
export async function submitReviewAction({ problemId, reviewerName, action, reviewComment }) {
  const record = unwrap(
    await supabase
      .from('kk_review_actions')
      .insert({
        problem_id: problemId,
        reviewer_name: reviewerName || null,
        action,
        review_comment: reviewComment || null,
      })
      .select()
      .single(),
  )

  // The action value maps 1:1 onto a problem status.
  await updateProblemStatus(problemId, action)
  return record
}

// ---- Acknowledgements & appeals (accountant reaction loop) -----------------
//
// Every QA issue (kk_problems row) can be reacted to by the assigned accountant:
//   * «Ознакомлен»        → acknowledgeProblem  (seen & accepted)
//   * «Подать апелляцию»   → submitAppeal        (dispute, status 'pending')
// Margarita / management then approve or reject each appeal (resolveAppeal).
// The current reaction is mirrored onto kk_problems.status so the queues and
// dashboard keep working. See supabase/migrations/0025.

// Mark an issue as seen & accepted. One acknowledgement per problem (idempotent
// upsert on problem_id); also moves the problem to the `acknowledged` status so
// it leaves the actionable queue.
export async function acknowledgeProblem({ problemId, accountantId, accountantName, note }) {
  const ack = unwrap(
    await supabase
      .from('kk_problem_acknowledgements')
      .upsert(
        {
          problem_id: problemId,
          accountant_id: accountantId || null,
          accountant_name: accountantName || null,
          note: note || null,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'problem_id' },
      )
      .select()
      .single(),
  )
  await updateProblemStatus(problemId, STATUS.acknowledged)
  return ack
}

export async function fetchAcknowledgement(problemId) {
  const rows = unwrap(
    await supabase.from('kk_problem_acknowledgements').select('*').eq('problem_id', problemId),
  )
  return rows[0] || null
}

export async function fetchAcknowledgements(filters = {}) {
  let query = supabase.from('kk_problem_acknowledgements').select('*')
  if (filters.accountantId) query = query.eq('accountant_id', filters.accountantId)
  return unwrap(await query)
}

// File an appeal against a QA issue with the accountant's explanation. Moves the
// problem to `appeal_pending`. A DB partial-unique index guarantees at most one
// pending appeal per problem (req 9), surfaced here as a friendly error.
export async function submitAppeal({ problemId, accountantId, accountantName, comment }) {
  const { data, error } = await supabase
    .from('kk_problem_appeals')
    .insert({
      problem_id: problemId,
      accountant_id: accountantId || null,
      accountant_name: accountantName || null,
      comment,
    })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') {
      throw new Error('По этой проблеме уже есть апелляция на рассмотрении.')
    }
    throw new Error(error.message)
  }
  await updateProblemStatus(problemId, STATUS.appeal_pending)
  return data
}

export async function fetchAppeals(filters = {}) {
  let query = supabase.from('kk_problem_appeals').select('*').order('created_at', { ascending: false })
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.statusIn?.length) query = query.in('status', filters.statusIn)
  if (filters.accountantId) query = query.eq('accountant_id', filters.accountantId)
  return unwrap(await query)
}

export async function fetchAppealsForProblem(problemId) {
  return unwrap(
    await supabase
      .from('kk_problem_appeals')
      .select('*')
      .eq('problem_id', problemId)
      .order('created_at', { ascending: false }),
  )
}

// Approve or reject an appeal. Approving upholds the accountant (the issue is
// dismissed and marked a false positive so it drops from dashboard counts, like
// a reviewer-confirmed non-problem); rejecting keeps the issue active/confirmed.
export async function resolveAppeal({ appealId, problemId, decision, resolvedBy, resolutionComment }) {
  const status = decision === 'approved' ? 'approved' : 'rejected'
  const appeal = unwrap(
    await supabase
      .from('kk_problem_appeals')
      .update({
        status,
        resolved_by: resolvedBy || null,
        resolution_comment: resolutionComment || null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', appealId)
      .select()
      .single(),
  )

  if (status === 'approved') {
    // Upholding the appeal dismisses the issue (marked a false positive so it
    // drops from dashboard counts) AND cancels any fine attached to the ticket
    // (req 4). Rejecting keeps both the issue and the fine active (req 4/5).
    unwrap(
      await supabase
        .from('kk_problems')
        .update({
          status: STATUS.appeal_approved,
          verdict: 'not_problematic',
          verdict_at: new Date().toISOString(),
          penalty_cancelled: true,
          penalty_cancelled_at: new Date().toISOString(),
        })
        .eq('problem_id', problemId),
    )
  } else {
    await updateProblemStatus(problemId, STATUS.appeal_rejected)
  }
  return appeal
}

// Set (or clear) the fine attached to a QA ticket. Recording a new amount also
// re-activates it (penalty_cancelled = false). Used by Margarita when a
// violation carries a sanction that wasn't imported automatically.
export async function setProblemPenalty({ problemId, amount }) {
  const value = amount === '' || amount === null || amount === undefined ? null : Number(amount)
  return unwrap(
    await supabase
      .from('kk_problems')
      .update({
        penalty_amount: value,
        penalty_cancelled: false,
        penalty_cancelled_at: null,
      })
      .eq('problem_id', problemId)
      .select()
      .single(),
  )
}

// ---- Margarita violation workflow (cross-app: writes to the QA platform) ---
//
// A `margarita_review` problem is a MIRROR of a row that actually lives in
// Margarita's QA platform (mqa_violations, id embedded as `margarita:<id>`).
// The QA platform owns the appeal decision, so the accountant's reaction on
// such a problem must NOT go to this app's kk_problem_* tables — it must write
// back to mqa_violations / mqa_violation_appeals so Margarita's platform,
// reports and Telegram see it, and her decision flows back here.
//
// Both apps share one Supabase project, and this app is a static SPA on the
// anon key, so the write path is two SECURITY DEFINER RPCs (migration 0027)
// that authenticate the login code, enforce ownership + validation + one-pending
// server-side, and are idempotent. Her live status + decision are read back from
// the kk_violation_workflow view (never trusting client state).

// Live workflow state (status, acknowledgement, latest appeal + decision) for a
// set of Margarita problems, or all of them when no ids are given.
export async function fetchViolationWorkflow(problemIds) {
  let query = supabase.from('kk_violation_workflow').select('*')
  if (problemIds?.length) query = query.in('problem_id', problemIds)
  return unwrap(await query)
}

export async function fetchViolationWorkflowForProblem(problemId) {
  const rows = unwrap(
    await supabase.from('kk_violation_workflow').select('*').eq('problem_id', problemId),
  )
  return rows[0] || null
}

// «Ознакомлен» on a Margarita violation. Resolves the violation id from the
// problem_id, sends the accountant's login code so the RPC can enforce ownership
// server-side, and persists into mqa_violations. Idempotent.
export async function acknowledgeViolation({ problemId, loginCode } = {}) {
  const violationId = violationIdFromProblemId(problemId)
  if (!violationId) throw new Error('Это не нарушение Маргариты — действие недоступно.')
  const code = loginCode || getStoredCode()
  if (!code) throw new Error('Требуется вход по коду.')
  const { data, error } = await supabase.rpc('kk_acknowledge_violation', {
    p_violation_id: violationId,
    p_login_code: code,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

// «Подать апелляцию» on a Margarita violation → inserts into
// mqa_violation_appeals and moves the violation to `appealed` (server-side).
// The appeal then appears in Margarita's own /appeals queue + reports.
export async function appealViolation({ problemId, loginCode, appealText } = {}) {
  const violationId = violationIdFromProblemId(problemId)
  if (!violationId) throw new Error('Это не нарушение Маргариты — действие недоступно.')
  const text = (appealText || '').trim()
  if (!text) throw new Error('Текст апелляции обязателен.')
  const code = loginCode || getStoredCode()
  if (!code) throw new Error('Требуется вход по коду.')
  const { data, error } = await supabase.rpc('kk_appeal_violation', {
    p_violation_id: violationId,
    p_login_code: code,
    p_appeal_text: text,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

// ---- Templated client notifications (plan → edit/attach → bot sends → log) -
// Reads through kk_* views; writes through kk_* SECURITY DEFINER RPCs that
// authenticate the login code and enforce chat ownership server-side (0035),
// exactly like the violation bridge above.

// The template catalog (client-facing wording + auto/manual + approved flag).
export async function fetchNotificationTemplates() {
  return unwrap(
    await supabase
      .from('kk_notification_templates')
      .select('id, category, subtype, language, mode, title, body, requires_attachment, approved, active'),
  )
}

// Small helper: call a scoped read RPC with the caller's login code and apply
// any remaining client-side filters. These reads are CLIENT-SENSITIVE (full
// message text / files / delivery log), so the server RPC returns only the
// caller's own companies (all for supervisors) — never an anon-wide view.
async function callScopedRpc(fn, loginCode) {
  const code = loginCode || getStoredCode()
  if (!code) throw new Error('Требуется вход по коду.')
  const { data, error } = await supabase.rpc(fn, { p_login_code: code })
  if (error) throw new Error(error.message)
  return data || []
}

// The planned 30-day chain (the upcoming messages the bot will send), scoped to
// the caller's own companies. Optional client-side filters narrow the result.
export async function fetchPlannedNotifications(filters = {}) {
  let rows = await callScopedRpc('kk_list_planned_notifications', filters.loginCode)
  if (filters.agrNo) rows = rows.filter((r) => r.agr_no === filters.agrNo)
  if (filters.agrNoIn?.length) {
    const set = new Set(filters.agrNoIn)
    rows = rows.filter((r) => set.has(r.agr_no))
  }
  if (filters.status) rows = rows.filter((r) => r.status === filters.status)
  if (filters.statusIn?.length) {
    const set = new Set(filters.statusIn)
    rows = rows.filter((r) => set.has(r.status))
  }
  if (filters.scheduledBefore) rows = rows.filter((r) => r.scheduled_date <= filters.scheduledBefore)
  return rows
}

// The manual-input attachments (files by month / mark-done) for MANUAL types,
// scoped to the caller's own companies.
export async function fetchNotificationAttachments(filters = {}) {
  let rows = await callScopedRpc('kk_list_notification_attachments', filters.loginCode)
  if (filters.agrNo) rows = rows.filter((r) => r.agr_no === filters.agrNo)
  if (filters.agrNoIn?.length) {
    const set = new Set(filters.agrNoIn)
    rows = rows.filter((r) => set.has(r.agr_no))
  }
  return rows
}

// The sent-notifications log ("all notifications sent to this client"), scoped
// to the caller's own companies.
export async function fetchSentNotifications(filters = {}) {
  let rows = await callScopedRpc('kk_list_sent_notifications', filters.loginCode)
  if (filters.agrNo) rows = rows.filter((r) => r.agr_no === filters.agrNo)
  if (filters.agrNoIn?.length) {
    const set = new Set(filters.agrNoIn)
    rows = rows.filter((r) => set.has(r.agr_no))
  }
  return rows
}

// Edit a planned message's text (audited server-side). Keeps it scheduled.
export async function editPlannedNotification({ plannedId, loginCode, newText } = {}) {
  if (plannedId == null) throw new Error('Не указано уведомление.')
  const text = (newText || '').trim()
  if (!text) throw new Error('Текст уведомления не может быть пустым.')
  const code = loginCode || getStoredCode()
  if (!code) throw new Error('Требуется вход по коду.')
  const { data, error } = await supabase.rpc('kk_edit_notification', {
    p_planned_id: String(plannedId),
    p_login_code: code,
    p_new_text: text,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

// NOTE: approve/cancel were removed (0036). The bot always sends the planned
// message at its scheduled time — it cannot be cancelled and there is no lock
// step; the accountant may only EDIT the text (any time before it is sent).

// Attach the monthly document / mark done for a MANUAL notification type, with
// optional accompanying text. Requires either a file URL or a mark-done flag.
export async function attachNotification({
  agrNo,
  period,
  category,
  loginCode,
  fileUrl = null,
  fileName = null,
  markedDone = false,
  accompanyingText = null,
} = {}) {
  if (!agrNo || !period || !category) throw new Error('Не указаны договор/период/категория.')
  if (!fileUrl && !markedDone) throw new Error('Приложите файл или отметьте «сделано».')
  const code = loginCode || getStoredCode()
  if (!code) throw new Error('Требуется вход по коду.')
  const { data, error } = await supabase.rpc('kk_attach_notification', {
    p_agr_no: agrNo,
    p_period: period,
    p_category: category,
    p_login_code: code,
    p_file_url: fileUrl,
    p_file_name: fileName,
    p_marked_done: markedDone,
    p_accompanying_text: accompanyingText,
  })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data[0] : data
}

// ---- Detection-quality ratings (learning signal) --------------------------

export async function fetchRatings(problemId) {
  return unwrap(
    await supabase
      .from('kk_problem_ratings')
      .select('*')
      .eq('problem_id', problemId)
      .order('created_at', { ascending: false }),
  )
}

// Record a reviewer's truthiness verdict on a detected problem and mirror it to
// kk_problems.verdict. A "not problematic" verdict makes the ingestion stop
// re-surfacing this detection (until a strictly newer episode); see
// supabase/migrations/0006_problem_ratings.sql.
export async function rateProblem({
  problemId,
  isProblematic,
  comment,
  ratedBy,
  problemDetectedAt,
}) {
  const rating = unwrap(
    await supabase
      .from('kk_problem_ratings')
      .insert({
        problem_id: problemId,
        is_problematic: isProblematic,
        comment: comment || null,
        rated_by: ratedBy || null,
        problem_detected_at: problemDetectedAt || null,
      })
      .select()
      .single(),
  )

  unwrap(
    await supabase
      .from('kk_problems')
      .update({
        verdict: isProblematic ? 'problematic' : 'not_problematic',
        verdict_at: new Date().toISOString(),
      })
      .eq('problem_id', problemId),
  )
  return rating
}

// ---- QA accuracy stats ----------------------------------------------------

// Aggregate the latest verdict (mirrored on kk_problems.verdict) into accuracy
// numbers. Counts each problem once; split by detection source and, for AI
// detections, by the problem_id prefix (unanswered / late / promise / review).
export async function fetchAccuracyStats() {
  const rows = unwrap(
    await supabase
      .from('kk_problems')
      .select('problem_id, source, verdict, problem_title')
      .not('verdict', 'is', null),
  )

  function agg(items) {
    const correct = items.filter((r) => r.verdict === 'problematic').length
    const incorrect = items.filter((r) => r.verdict === 'not_problematic').length
    const total = items.length
    const accuracy = total > 0 ? Math.round((correct / total) * 10000) / 100 : null
    return { total, correct, incorrect, accuracy }
  }

  const overall = agg(rows)

  const srcMap = {}
  for (const r of rows) {
    const src = r.source || 'unknown'
    if (!srcMap[src]) srcMap[src] = []
    srcMap[src].push(r)
  }
  const perSource = Object.entries(srcMap)
    .map(([source, items]) => ({ source, ...agg(items) }))
    .sort((a, b) => b.total - a.total)

  // Group by the CURRENT kind (problem_title-driven via qaKind), not the
  // problem_id prefix — a reclassified «Поздний ответ» keeps its `unanswered:` id
  // but must count under `late`, matching what the QA page shows.
  const aiRows = rows.filter((r) => r.source === 'ai')
  const subtypeMap = {}
  for (const r of aiRows) {
    const prefix = qaKind(r) || 'other'
    if (!subtypeMap[prefix]) subtypeMap[prefix] = []
    subtypeMap[prefix].push(r)
  }
  const aiSubtypes = Object.entries(subtypeMap)
    .map(([prefix, items]) => ({ prefix, ...agg(items) }))
    .sort((a, b) => b.total - a.total)

  return { overall, perSource, aiSubtypes }
}

// ---- Sona cross-platform comments -----------------------------------------

// Comments Sona posts on a kk_problem after reading accountant feedback.
// Visible on both platforms; supervisors can reply from the kk side.
export async function fetchSonaComments(problemId) {
  return unwrap(
    await supabase
      .from('kk_sona_comments')
      .select('*')
      .eq('problem_id', problemId)
      .order('created_at', { ascending: true }),
  )
}

export async function addSonaComment(problemId, body, author) {
  return unwrap(
    await supabase
      .from('kk_sona_comments')
      .insert({ problem_id: problemId, body, author })
      .select()
      .single(),
  )
}

// ---- Tasks -----------------------------------------------------------------

export async function fetchTasks(filters = {}) {
  let query = supabase.from('kk_tasks').select('*').order('created_at', { ascending: false })
  if (filters.accountantId) query = query.eq('accountant_id', filters.accountantId)
  // A regular accountant's own tasks: assigned to them OR created by them. This
  // still surfaces tasks created from the Клиенты page before an owner was
  // stamped (accountant_id null) as long as created_by is their name.
  if (filters.mine) {
    const clauses = []
    if (filters.mine.accountantId) clauses.push(`accountant_id.eq.${filters.mine.accountantId}`)
    if (filters.mine.createdBy) clauses.push(`created_by.eq."${filters.mine.createdBy}"`)
    if (clauses.length) query = query.or(clauses.join(','))
  }
  if (filters.taskType) query = query.eq('task_type', filters.taskType)
  if (filters.done !== undefined) query = query.eq('done', filters.done)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.problemId) query = query.eq('problem_id', filters.problemId)
  if (filters.clientName) query = query.eq('client_name', filters.clientName)
  return unwrap(await query)
}

export async function createTask(task) {
  return unwrap(await supabase.from('kk_tasks').insert(task).select().single())
}

// Move a task between open / in_progress / postponed / done / cancelled,
// keeping the legacy `done` flag (and its completion timestamps) consistent
// with the richer status. `done_at` doubles as the required completed_at.
export async function setTaskStatus(taskId, status, actor) {
  const done = status === 'done'
  return unwrap(
    await supabase
      .from('kk_tasks')
      .update({
        status,
        done,
        done_at: done ? new Date().toISOString() : null,
        done_by: done ? actor || null : null,
      })
      .eq('id', taskId)
      .select()
      .single(),
  )
}

// Postpone a task to a new due date (its original due_date is preserved). Moves
// the task into the `postponed` state.
export async function postponeTask(taskId, newDueDate) {
  return unwrap(
    await supabase
      .from('kk_tasks')
      .update({ status: 'postponed', done: false, due_date_postponed: newDueDate || null })
      .eq('id', taskId)
      .select()
      .single(),
  )
}

export async function completeTask(taskId, doneBy) {
  return setTaskStatus(taskId, 'done', doneBy)
}

export async function reopenTask(taskId) {
  return setTaskStatus(taskId, 'open')
}

export async function deleteTask(taskId) {
  return unwrap(await supabase.from('kk_tasks').delete().eq('id', taskId))
}

// ---- Feedback attachments ---------------------------------------------------
//
// Optional files (documents/screenshots of the work done) an accountant can
// attach with feedback. Files go to the public `kk-attachments` bucket; one
// metadata row per file in kk_problem_attachments. Sona's platform reads the
// same table to show the files next to the accountant's answer.

// Storage keys must be ASCII-safe; keep the original name in file_name and
// build a sanitized unique path here. Exported for tests.
export function attachmentStoragePath(problemId, fileName, unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const safeId = String(problemId).replace(/[^a-zA-Z0-9_-]+/g, '_')
  const dot = fileName.lastIndexOf('.')
  const base =
    (dot > 0 ? fileName.slice(0, dot) : fileName)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'file'
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : ''
  return `${safeId}/${unique}-${base}${ext ? '.' + ext : ''}`
}

export async function uploadFeedbackAttachment({ problemId, file, uploadedBy }) {
  const path = attachmentStoragePath(problemId, file.name)
  const { error: uploadError } = await supabase.storage
    .from('kk-attachments')
    .upload(path, file, { contentType: file.type || undefined })
  if (uploadError) throw new Error(uploadError.message)

  const { data: pub } = supabase.storage.from('kk-attachments').getPublicUrl(path)
  return unwrap(
    await supabase
      .from('kk_problem_attachments')
      .insert({
        problem_id: problemId,
        file_name: file.name,
        storage_path: path,
        public_url: pub.publicUrl,
        mime_type: file.type || null,
        size_bytes: file.size ?? null,
        uploaded_by: uploadedBy || null,
      })
      .select()
      .single(),
  )
}

export async function fetchAttachments(problemId) {
  return unwrap(
    await supabase
      .from('kk_problem_attachments')
      .select('*')
      .eq('problem_id', problemId)
      .order('created_at', { ascending: true }),
  )
}

// ---- Artyom project: real ArmSoft / TaxService work (for «сравнение с базой») --
// These read the OB Artyom project (see artyomClient.js), NOT the KK project.
// They feed the DbComparison / DailyAnalysis panels and are shaped exactly like
// what Accounting.jsx already reads, so the pure logic in artyomCompare.js works
// unchanged. Every function is a no-op (returns []) when Artyom isn't configured,
// so the feedback form still works without the accounting DB.

function ymd(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10)
}

/** Registered companies with their accountant + ArmSoft/tax bindings. */
export async function fetchArtyomCompanies() {
  if (!artyom) return []
  const { data, error } = await artyom
    .from('ob_accounting_companies')
    .select('id, company_name, contract_number, accountant_name, is_active, armsoft_company_id, tax_account_id')
    .order('company_name')
  if (error) throw new Error(error.message)
  return data ?? []
}

/**
 * Per company/accountant/day work counts, split by system_source
 * (base | armsoft | taxservice), within [from, to] (inclusive, YYYY-MM-DD).
 * Optionally narrowed to one accountant.
 */
export async function fetchArtyomActivities({ from, to, accountantName } = {}) {
  if (!artyom) return []
  let q = artyom
    .from('accounting_activities')
    .select('company_name, accountant_name, activity_date, system_source, invoices_issued, reports_submitted, applications_filed, balance_changes')
  if (from) q = q.gte('activity_date', ymd(from))
  if (to) q = q.lte('activity_date', ymd(to))
  if (accountantName) q = q.eq('accountant_name', accountantName)
  const { data, error } = await q.order('activity_date', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Accountant daily comments (the «слова» in the accounting reporting tool). */
export async function fetchArtyomComments({ from, to, accountantName } = {}) {
  if (!artyom) return []
  let q = artyom
    .from('accountant_daily_comments')
    .select('accountant_name, company_name, comment_date, comment, unaccounted_work')
  if (from) q = q.gte('comment_date', ymd(from))
  if (to) q = q.lte('comment_date', ymd(to))
  if (accountantName) q = q.eq('accountant_name', accountantName)
  const { data, error } = await q.order('comment_date', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}
