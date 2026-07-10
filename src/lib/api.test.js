import { describe, it, expect, beforeEach, vi } from 'vitest'

// Records every insert/update so tests can assert the call sequence.
const calls = []

function builder(table) {
  const state = { table, payload: null }
  const b = {
    select: vi.fn(() => b),
    order: vi.fn(() => b),
    eq: vi.fn(() => b),
    in: vi.fn(() => b),
    not: vi.fn(() => b),
    gte: vi.fn(() => b),
    or: vi.fn(() => b),
    insert: vi.fn((p) => {
      state.payload = p
      calls.push({ op: 'insert', table, payload: p })
      return b
    }),
    upsert: vi.fn((p) => {
      state.payload = p
      calls.push({ op: 'upsert', table, payload: p })
      return b
    }),
    update: vi.fn((p) => {
      state.payload = p
      calls.push({ op: 'update', table, payload: p })
      return b
    }),
    delete: vi.fn(() => {
      calls.push({ op: 'delete', table })
      return b
    }),
    // insert(...).select().single() resolves with the row we just wrote.
    single: vi.fn(() => Promise.resolve({ data: state.payload || {}, error: null })),
    // bare `await query` (list reads) resolves to an empty array.
    then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
  }
  return b
}

vi.mock('./supabaseClient', () => ({
  supabase: { from: vi.fn((t) => builder(t)) },
  supabaseConfigError: null,
}))

import {
  submitAccountantFeedback,
  submitReviewAction,
  rateProblem,
  acknowledgeProblem,
  submitAppeal,
  resolveAppeal,
  setTaskStatus,
} from './api'

beforeEach(() => {
  calls.length = 0
})

describe('rateProblem', () => {
  it('records the rating and mirrors a "false positive" verdict onto the problem', async () => {
    await rateProblem({
      problemId: 'unanswered:-1:emp',
      isProblematic: false,
      comment: 'staff did answer',
      ratedBy: 'QA',
      problemDetectedAt: '2026-06-18T00:00:00Z',
    })

    const insert = calls.find((c) => c.op === 'insert')
    expect(insert.table).toBe('kk_problem_ratings')
    expect(insert.payload.problem_id).toBe('unanswered:-1:emp')
    expect(insert.payload.is_problematic).toBe(false)
    expect(insert.payload.problem_detected_at).toBe('2026-06-18T00:00:00Z')

    const update = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(update.payload.verdict).toBe('not_problematic')
  })

  it('maps a positive rating to the "problematic" verdict', async () => {
    await rateProblem({ problemId: 'p', isProblematic: true })
    const update = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(update.payload.verdict).toBe('problematic')
  })
})

describe('submitAccountantFeedback', () => {
  it('saves both comments then moves the problem to the review queue', async () => {
    await submitAccountantFeedback({
      problemId: 'P-1',
      accountantId: 'acc-1',
      accountantName: 'Анна',
      situationComment: 'because X',
      solutionComment: 'will do Y',
    })

    const insert = calls.find((c) => c.op === 'insert')
    expect(insert.table).toBe('kk_accountant_feedback')
    expect(insert.payload.situation_comment).toBe('because X')
    expect(insert.payload.solution_comment).toBe('will do Y')

    const update = calls.find((c) => c.op === 'update')
    expect(update.table).toBe('kk_problems')
    expect(update.payload.status).toBe('submitted_by_accountant')
  })
})

describe('submitReviewAction', () => {
  it.each([
    ['fixed', 'fixed'],
    ['explained_accepted', 'explained_accepted'],
    ['returned_to_accountant', 'returned_to_accountant'],
  ])('action %s maps the problem status to %s', async (action, expected) => {
    await submitReviewAction({ problemId: 'P-1', reviewerName: 'R', action, reviewComment: 'ok' })

    const insert = calls.find((c) => c.op === 'insert')
    expect(insert.table).toBe('kk_review_actions')
    expect(insert.payload.action).toBe(action)

    const update = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(update.payload.status).toBe(expected)
  })

  it('stores null instead of empty strings for optional fields', async () => {
    await submitReviewAction({ problemId: 'P-1', reviewerName: '', action: 'fixed', reviewComment: '' })
    const insert = calls.find((c) => c.op === 'insert')
    expect(insert.payload.reviewer_name).toBeNull()
    expect(insert.payload.review_comment).toBeNull()
  })
})

describe('acknowledgeProblem', () => {
  it('upserts an acknowledgement then marks the problem acknowledged', async () => {
    await acknowledgeProblem({ problemId: 'P-1', accountantId: 'a1', accountantName: 'Анна' })

    const ack = calls.find((c) => c.op === 'upsert')
    expect(ack.table).toBe('kk_problem_acknowledgements')
    expect(ack.payload.problem_id).toBe('P-1')
    expect(ack.payload.accountant_id).toBe('a1')

    const update = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(update.payload.status).toBe('acknowledged')
  })
})

describe('submitAppeal', () => {
  it('records the appeal comment then moves the problem to appeal_pending', async () => {
    await submitAppeal({ problemId: 'P-1', accountantId: 'a1', accountantName: 'Анна', comment: 'не согласен' })

    const insert = calls.find((c) => c.op === 'insert')
    expect(insert.table).toBe('kk_problem_appeals')
    expect(insert.payload.comment).toBe('не согласен')

    const update = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(update.payload.status).toBe('appeal_pending')
  })
})

describe('resolveAppeal', () => {
  it('approving marks the appeal approved and dismisses the problem as a false positive', async () => {
    await resolveAppeal({ appealId: 'ap1', problemId: 'P-1', decision: 'approved', resolvedBy: 'Маргарита' })

    const appealUpd = calls.find((c) => c.op === 'update' && c.table === 'kk_problem_appeals')
    expect(appealUpd.payload.status).toBe('approved')

    const probUpd = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(probUpd.payload.status).toBe('appeal_approved')
    expect(probUpd.payload.verdict).toBe('not_problematic')
  })

  it('rejecting keeps the problem active (appeal_rejected)', async () => {
    await resolveAppeal({ appealId: 'ap1', problemId: 'P-1', decision: 'rejected' })

    const appealUpd = calls.find((c) => c.op === 'update' && c.table === 'kk_problem_appeals')
    expect(appealUpd.payload.status).toBe('rejected')

    const probUpd = calls.find((c) => c.op === 'update' && c.table === 'kk_problems')
    expect(probUpd.payload.status).toBe('appeal_rejected')
    expect(probUpd.payload.verdict).toBeUndefined()
  })
})

describe('setTaskStatus', () => {
  it('done syncs the legacy done flag + timestamp', async () => {
    await setTaskStatus('t1', 'done', 'Анна')
    const upd = calls.find((c) => c.op === 'update' && c.table === 'kk_tasks')
    expect(upd.payload.status).toBe('done')
    expect(upd.payload.done).toBe(true)
    expect(upd.payload.done_by).toBe('Анна')
  })

  it('a non-done status clears the done flag', async () => {
    await setTaskStatus('t1', 'in_progress')
    const upd = calls.find((c) => c.op === 'update' && c.table === 'kk_tasks')
    expect(upd.payload.status).toBe('in_progress')
    expect(upd.payload.done).toBe(false)
    expect(upd.payload.done_at).toBeNull()
  })
})

describe('attachmentStoragePath', () => {
  it('sanitizes the problem id and file name into an ASCII-safe storage key', async () => {
    const { attachmentStoragePath } = await import('./api')
    const path = attachmentStoragePath('sona:42', 'скриншот работы (1).PNG', 'u1')
    expect(path).toBe('sona_42/u1-1.png')

    const latin = attachmentStoragePath('sona:42', 'report v2.pdf', 'u1')
    expect(latin).toBe('sona_42/u1-report_v2.pdf')
  })

  it('handles names without extension and never produces an empty base', async () => {
    const { attachmentStoragePath } = await import('./api')
    expect(attachmentStoragePath('KK-2026-1', 'notes', 'u2')).toBe('KK-2026-1/u2-notes')
    expect(attachmentStoragePath('KK-2026-1', '...', 'u2')).toBe('KK-2026-1/u2-file')
  })
})
