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
    insert: vi.fn((p) => {
      state.payload = p
      calls.push({ op: 'insert', table, payload: p })
      return b
    }),
    update: vi.fn((p) => {
      state.payload = p
      calls.push({ op: 'update', table, payload: p })
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

import { submitAccountantFeedback, submitReviewAction, rateProblem } from './api'

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
