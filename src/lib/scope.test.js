import { describe, it, expect } from 'vitest'
import {
  SUPERVISOR_ROLES,
  seesAllClients,
  canManage,
  ownsProblem,
  keepOwnProblems,
} from './scope'

const accountant = {
  employee_id: 'emp-uuid-1',
  full_name: 'Naira Mkhitaryan',
  role: 'accountant',
  can_see_all: false,
}

describe('seesAllClients', () => {
  it('is false without an identity', () => {
    expect(seesAllClients(null)).toBe(false)
  })

  it('is true for every supervisor role', () => {
    for (const role of SUPERVISOR_ROLES) {
      expect(seesAllClients({ role, can_see_all: false })).toBe(true)
    }
  })

  it('is false for a regular accountant', () => {
    expect(seesAllClients(accountant)).toBe(false)
  })

  it('honours the can_see_all override regardless of role', () => {
    expect(seesAllClients({ role: 'accountant', can_see_all: true })).toBe(true)
  })
})

describe('canManage', () => {
  it('tracks supervisor status (Review / Admin access)', () => {
    expect(canManage(accountant)).toBe(false)
    expect(canManage({ role: 'admin' })).toBe(true)
    expect(canManage({ role: 'manager' })).toBe(false)
  })
})

describe('ownsProblem', () => {
  it('matches on the employee uuid stored in accountant_id', () => {
    expect(ownsProblem({ accountant_id: 'emp-uuid-1' }, accountant)).toBe(true)
  })

  it('matches on full_name vs accountant_name (case / spacing insensitive)', () => {
    expect(ownsProblem({ accountant_name: '  naira   mkhitaryan ' }, accountant)).toBe(true)
  })

  it('matches on full_name stored in the accountant_id field', () => {
    expect(ownsProblem({ accountant_id: 'Naira Mkhitaryan' }, accountant)).toBe(true)
  })

  it('does not match a different accountant', () => {
    expect(ownsProblem({ accountant_id: 'acc-other', accountant_name: 'Олья' }, accountant)).toBe(
      false,
    )
  })

  it('is false when there is no identity or no problem', () => {
    expect(ownsProblem({ accountant_id: 'emp-uuid-1' }, null)).toBe(false)
    expect(ownsProblem(null, accountant)).toBe(false)
  })
})

describe('keepOwnProblems', () => {
  const rows = [
    { problem_id: 'P1', accountant_id: 'emp-uuid-1' },
    { problem_id: 'P2', accountant_name: 'Naira Mkhitaryan' },
    { problem_id: 'P3', accountant_id: 'acc-other', accountant_name: 'Олья' },
  ]

  it('returns every row for a supervisor', () => {
    const sup = { role: 'head_accountant' }
    expect(keepOwnProblems(rows, sup)).toHaveLength(3)
  })

  it('narrows to the accountant’s own rows', () => {
    const kept = keepOwnProblems(rows, accountant).map((r) => r.problem_id)
    expect(kept).toEqual(['P1', 'P2'])
  })

  it('tolerates null/undefined input', () => {
    expect(keepOwnProblems(null, accountant)).toEqual([])
    expect(keepOwnProblems(undefined, { role: 'admin' })).toEqual([])
  })
})
