import { describe, it, expect } from 'vitest'
import {
  summarizeAppeals,
  groupAppealsByProblem,
  countByDay,
  perAccountantReport,
  buildWorkReport,
  isResolved,
} from './reports'

const problems = [
  { problem_id: 'm1', source: 'margarita_review', accountant_id: 'a1', accountant_name: 'Анна', status: 'new', detected_at: '2026-07-01T09:00:00Z', problem_title: 'Late reply' },
  { problem_id: 'm2', source: 'margarita_review', accountant_id: 'a1', accountant_name: 'Анна', status: 'acknowledged', detected_at: '2026-07-01T10:00:00Z', problem_title: 'Missing doc' },
  { problem_id: 'm3', source: 'margarita_review', accountant_id: 'a2', accountant_name: 'Борис', status: 'appeal_rejected', detected_at: '2026-07-02T09:00:00Z', problem_title: 'Wrong VAT' },
  { problem_id: 'm4', source: 'margarita_review', accountant_id: 'a2', accountant_name: 'Борис', status: 'appeal_approved', detected_at: '2026-07-02T11:00:00Z', problem_title: 'Bad tone' },
]

const appeals = [
  { id: 'ap1', problem_id: 'm3', accountant_id: 'a2', status: 'rejected', created_at: '2026-07-03T09:00:00Z' },
  { id: 'ap2', problem_id: 'm4', accountant_id: 'a2', status: 'approved', created_at: '2026-07-03T10:00:00Z' },
  { id: 'ap3', problem_id: 'm1', accountant_id: 'a1', status: 'pending', created_at: '2026-07-03T11:00:00Z' },
]

const acks = [{ problem_id: 'm2', accountant_id: 'a1' }]

describe('summarizeAppeals', () => {
  it('counts each status', () => {
    expect(summarizeAppeals(appeals)).toEqual({ total: 3, pending: 1, approved: 1, rejected: 1 })
  })
  it('handles an empty list', () => {
    expect(summarizeAppeals()).toEqual({ total: 0, pending: 0, approved: 0, rejected: 0 })
  })
})

describe('isResolved', () => {
  it('treats acknowledged / approved / fixed as resolved but not pending / rejected', () => {
    expect(isResolved('acknowledged')).toBe(true)
    expect(isResolved('appeal_approved')).toBe(true)
    expect(isResolved('fixed')).toBe(true)
    expect(isResolved('appeal_rejected')).toBe(false)
    expect(isResolved('new')).toBe(false)
  })
})

describe('groupAppealsByProblem', () => {
  it('buckets appeals by problem_id', () => {
    const g = groupAppealsByProblem(appeals)
    expect(g.get('m3').map((a) => a.id)).toEqual(['ap1'])
    expect(g.get('m1')[0].status).toBe('pending')
  })
})

describe('countByDay', () => {
  it('buckets by calendar day, newest first', () => {
    expect(countByDay(problems, 'detected_at')).toEqual([
      { date: '2026-07-02', count: 2 },
      { date: '2026-07-01', count: 2 },
    ])
  })
  it('ignores rows without the date field', () => {
    expect(countByDay([{ created_at: null }, { created_at: '2026-07-01T00:00:00Z' }], 'created_at')).toEqual([
      { date: '2026-07-01', count: 1 },
    ])
  })
})

describe('perAccountantReport', () => {
  const rows = perAccountantReport({ problems, appeals, acks })

  it('produces one row per accountant, sorted by issue count', () => {
    expect(rows.map((r) => r.accountantName)).toEqual(['Анна', 'Борис'])
  })

  it('counts issues, reviewed, open, and appeal outcomes per accountant', () => {
    const anna = rows.find((r) => r.accountantName === 'Анна')
    expect(anna.issues).toBe(2)
    // m2 acknowledged (reviewed + resolved); m1 new (open) with a pending appeal
    expect(anna.reviewed).toBe(1)
    expect(anna.open).toBe(1)
    expect(anna.appeals).toBe(1)
    expect(anna.pending).toBe(1)

    const boris = rows.find((r) => r.accountantName === 'Борис')
    expect(boris.issues).toBe(2)
    expect(boris.appeals).toBe(2)
    expect(boris.approved).toBe(1)
    expect(boris.rejected).toBe(1)
    // m3 appeal_rejected is still open; m4 appeal_approved is resolved
    expect(boris.open).toBe(1)
  })

  it('lists each issue with its current status', () => {
    const boris = rows.find((r) => r.accountantName === 'Борис')
    expect(boris.items.map((i) => i.status).sort()).toEqual(['appeal_approved', 'appeal_rejected'])
  })
})

describe('buildWorkReport', () => {
  it('assembles the top-level workload figures', () => {
    const r = buildWorkReport({ problems, appeals, acks })
    expect(r.issuesCreated).toBe(4)
    expect(r.acknowledged).toBe(1)
    expect(r.appeals).toEqual({ total: 3, pending: 1, approved: 1, rejected: 1 })
    expect(r.byAccountant).toHaveLength(2)
    expect(r.issuesByDay).toHaveLength(2)
  })
})
