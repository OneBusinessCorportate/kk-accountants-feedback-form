import { supabase } from './supabaseClient'
import { STATUS } from './constants'
import { qaKind } from './ingestion'

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
  if (filters.taskType) query = query.eq('task_type', filters.taskType)
  if (filters.done !== undefined) query = query.eq('done', filters.done)
  if (filters.clientName) query = query.eq('client_name', filters.clientName)
  return unwrap(await query)
}

export async function createTask(task) {
  return unwrap(await supabase.from('kk_tasks').insert(task).select().single())
}

export async function completeTask(taskId, doneBy) {
  return unwrap(
    await supabase
      .from('kk_tasks')
      .update({ done: true, done_at: new Date().toISOString(), done_by: doneBy || null })
      .eq('id', taskId)
      .select()
      .single(),
  )
}

export async function reopenTask(taskId) {
  return unwrap(
    await supabase
      .from('kk_tasks')
      .update({ done: false, done_at: null, done_by: null })
      .eq('id', taskId)
      .select()
      .single(),
  )
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
