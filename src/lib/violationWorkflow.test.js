import { describe, it, expect } from 'vitest'
import {
  MARGARITA_PREFIX,
  isMargaritaProblem,
  violationIdFromProblemId,
  interpretWorkflow,
  indexWorkflow,
} from './violationWorkflow'

describe('violationIdFromProblemId', () => {
  it('recovers the mqa_violations id from a margarita problem_id', () => {
    expect(violationIdFromProblemId('margarita:abc-123')).toBe('abc-123')
    expect(violationIdFromProblemId(`${MARGARITA_PREFIX}42`)).toBe('42')
  })

  it('returns null for non-margarita / malformed keys', () => {
    expect(violationIdFromProblemId('sona:9')).toBeNull()
    expect(violationIdFromProblemId('margarita_eval:9')).toBeNull() // eval source is NOT a violation
    expect(violationIdFromProblemId('margarita:')).toBeNull()
    expect(violationIdFromProblemId('margarita:   ')).toBeNull()
    expect(violationIdFromProblemId(null)).toBeNull()
    expect(violationIdFromProblemId(undefined)).toBeNull()
  })
})

describe('isMargaritaProblem', () => {
  it('is true only for a margarita_review row keyed margarita:<id>', () => {
    expect(isMargaritaProblem({ source: 'margarita_review', problem_id: 'margarita:1' })).toBe(true)
  })
  it('is false for other sources or eval-sourced margarita rows', () => {
    expect(isMargaritaProblem({ source: 'sona_review', problem_id: 'sona:1' })).toBe(false)
    // A «Критично» evaluation is source margarita_review but keyed margarita_eval:
    // — it has no mqa_violations row, so it must use the local kk_problem flow.
    expect(isMargaritaProblem({ source: 'margarita_review', problem_id: 'margarita_eval:1' })).toBe(false)
    expect(isMargaritaProblem(null)).toBe(false)
  })
})

describe('interpretWorkflow', () => {
  it('a missing/new row is actionable (acknowledge + appeal)', () => {
    for (const row of [null, undefined, { status: 'new' }]) {
      const wf = interpretWorkflow(row)
      expect(wf.status).toBe('new')
      expect(wf.canAcknowledge).toBe(true)
      expect(wf.canAppeal).toBe(true)
      expect(wf.acknowledged).toBe(false)
      expect(wf.decided).toBe(false)
    }
  })

  it('acknowledged: no more acknowledge, appeal still allowed', () => {
    const wf = interpretWorkflow({ status: 'acknowledged' })
    expect(wf.acknowledged).toBe(true)
    expect(wf.canAcknowledge).toBe(false)
    expect(wf.canAppeal).toBe(true)
    expect(wf.pendingAppeal).toBe(false)
  })

  it('appealed: pending, read-only for the accountant', () => {
    const wf = interpretWorkflow({ status: 'appealed', appeal_text: 'не согласен' })
    expect(wf.pendingAppeal).toBe(true)
    expect(wf.canAcknowledge).toBe(false)
    expect(wf.canAppeal).toBe(false)
    expect(wf.appealText).toBe('не согласен')
  })

  it('appeal_approved surfaces the decision + comment', () => {
    const wf = interpretWorkflow({ status: 'appeal_approved', decision_comment: 'права' })
    expect(wf.decided).toBe(true)
    expect(wf.approved).toBe(true)
    expect(wf.rejected).toBe(false)
    expect(wf.canAcknowledge).toBe(false)
    expect(wf.canAppeal).toBe(false)
    expect(wf.decisionComment).toBe('права')
  })

  it('appeal_rejected is decided (not approved)', () => {
    const wf = interpretWorkflow({ status: 'appeal_rejected' })
    expect(wf.decided).toBe(true)
    expect(wf.rejected).toBe(true)
    expect(wf.approved).toBe(false)
  })
})

describe('indexWorkflow', () => {
  it('keys rows by problem_id (and derives it from violation_id when absent)', () => {
    const map = indexWorkflow([
      { problem_id: 'margarita:1', status: 'new' },
      { violation_id: '2', status: 'appealed' },
      null,
    ])
    expect(map.get('margarita:1').status).toBe('new')
    expect(map.get('margarita:2').status).toBe('appealed')
    expect(map.size).toBe(2)
  })
})
