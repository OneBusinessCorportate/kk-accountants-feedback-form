import { describe, it, expect } from 'vitest'
import { buildQualityReport, urgentIssues } from './qualityReport'

// A high-priority problem detected long ago (so it's SLA-breached → «ОЧЕНЬ
// СРОЧНО») vs a fresh one.
const LONG_AGO = '2020-01-01T08:00:00Z'
const NOW = new Date('2020-01-10T12:00:00Z')

function problem(over = {}) {
  return {
    problem_id: Math.random().toString(36).slice(2),
    source: 'margarita_review',
    status: 'waiting_for_accountant',
    priority: 2,
    accountant_id: 'a1',
    accountant_name: 'Анна',
    detected_at: LONG_AGO,
    ...over,
  }
}

describe('buildQualityReport', () => {
  it('merges problems, praise and checks per accountant', () => {
    const r = buildQualityReport({
      problems: [
        problem({ accountant_id: 'a1', accountant_name: 'Анна' }),
        problem({ accountant_id: 'a1', accountant_name: 'Анна', status: 'fixed' }),
        problem({ accountant_id: 'a2', accountant_name: 'Борис' }),
      ],
      praise: [
        { accountant_id: 'a1', accountant_name: 'Анна', source: 'sona_review' },
        { accountant_id: 'a1', accountant_name: 'Анна', source: 'margarita_review' },
      ],
      sonaChecks: [
        { chat_agr_no: 'C1', accountant_id: 'a1', accountant_name: 'Анна' },
        { chat_agr_no: 'C1', accountant_id: 'a1', accountant_name: 'Анна' }, // dup company
        { chat_agr_no: 'C2', accountant_id: 'a2', accountant_name: 'Борис' },
      ],
      margaritaChecks: [{ chat_agr_no: 'M1', accountant_id: 'a1', accountant_name: 'Анна' }],
      now: NOW,
    })

    expect(r.department.accountants).toBe(2)
    expect(r.department.issues).toBe(3)
    expect(r.department.praise).toBe(2)
    expect(r.department.checkedBySona).toBe(2) // C1, C2
    expect(r.department.checkedByMargarita).toBe(1)

    const anna = r.byAccountant.find((x) => x.accountantId === 'a1')
    expect(anna.issues).toBe(2)
    expect(anna.open).toBe(1) // one is fixed
    expect(anna.praise).toBe(2)
    expect(anna.checkedBySona).toBe(1) // distinct companies
    expect(anna.checkedByMargarita).toBe(1)
    expect(anna.balance).toBe(0) // 2 praise − 2 issues
  })

  it('counts «ОЧЕНЬ СРОЧНО» (priority 1 + overdue) into urgent', () => {
    const r = buildQualityReport({
      problems: [
        problem({ priority: 1, detected_at: LONG_AGO }), // urgent
        problem({ priority: 1, detected_at: NOW.toISOString() }), // fresh → not urgent
      ],
      now: NOW,
    })
    expect(r.department.urgent).toBe(1)
  })

  it('sorts accountants with urgent issues first', () => {
    const r = buildQualityReport({
      problems: [
        problem({ accountant_id: 'calm', accountant_name: 'Спокойный', priority: 3 }),
        problem({ accountant_id: 'calm', accountant_name: 'Спокойный', priority: 3 }),
        problem({ accountant_id: 'hot', accountant_name: 'Горящий', priority: 1, detected_at: LONG_AGO }),
      ],
      now: NOW,
    })
    expect(r.byAccountant[0].accountantId).toBe('hot')
  })

  it('is safe on empty input', () => {
    const r = buildQualityReport({})
    expect(r.department.issues).toBe(0)
    expect(r.byAccountant).toEqual([])
  })
})

describe('urgentIssues', () => {
  it('returns only open, priority-1, SLA-breached issues, oldest first', () => {
    const older = problem({ priority: 1, detected_at: '2020-01-02T08:00:00Z' })
    const newer = problem({ priority: 1, detected_at: '2020-01-05T08:00:00Z' })
    const fresh = problem({ priority: 1, detected_at: NOW.toISOString() })
    const resolved = problem({ priority: 1, detected_at: LONG_AGO, status: 'fixed' })
    const list = urgentIssues([newer, older, fresh, resolved], NOW)
    expect(list.map((p) => p.problem_id)).toEqual([older.problem_id, newer.problem_id])
  })
})
