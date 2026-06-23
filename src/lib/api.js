import { supabase } from './supabaseClient'
import { STATUS } from './constants'

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
