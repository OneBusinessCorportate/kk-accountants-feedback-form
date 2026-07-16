import { describe, it, expect } from 'vitest'
import { selectYesterdayTickets, answeredProblemIds, computeGate, isBlocked } from './ticketGate'

// Fixed clock: 2026-07-15 13:00 Yerevan → yesterday = 2026-07-14 (full local day).
const NOW = new Date('2026-07-15T09:00:00Z')
const YESTERDAY = '2026-07-14T08:00:00Z' // 12:00 Yerevan, 14 July
const TODAY = '2026-07-15T08:00:00Z' // 12:00 Yerevan, 15 July
const OLDER = '2026-07-10T08:00:00Z'

const ACC = { employee_id: 'emp-1', full_name: 'Ivan Petrov', role: 'accountant', can_see_all: false }
const BOSS = { employee_id: 'emp-9', full_name: 'Boss', role: 'head_accountant', can_see_all: false }

const CHATS = [{ agr_no: 'B-1', chat_link: 'https://t.me/active', status: 'Active' }]

const ticket = (o = {}) => ({
  problem_id: o.problem_id || 'margarita:1',
  source: o.source || 'margarita_review',
  verdict: o.verdict ?? null,
  status: o.status || 'waiting_for_accountant',
  priority: o.priority ?? 1,
  chat_link: o.chat_link ?? 'https://t.me/active',
  contract_id: o.contract_id ?? 'B-1',
  client_name: o.client_name || 'Client',
  accountant_id: o.accountant_id ?? 'emp-1',
  accountant_name: o.accountant_name ?? 'Ivan Petrov',
  problem_title: o.problem_title || 'Проблема',
  detected_at: o.detected_at || YESTERDAY,
})

describe('selectYesterdayTickets', () => {
  it("keeps the accountant's active yesterday tickets", () => {
    const tickets = selectYesterdayTickets({
      problems: [ticket({ problem_id: 'p1' })],
      chats: CHATS,
      access: ACC,
      now: NOW,
    })
    expect(tickets.map((t) => t.problem_id)).toEqual(['p1'])
  })

  it('excludes today and older tickets', () => {
    const tickets = selectYesterdayTickets({
      problems: [
        ticket({ problem_id: 'today', detected_at: TODAY }),
        ticket({ problem_id: 'old', detected_at: OLDER }),
      ],
      chats: CHATS,
      access: ACC,
      now: NOW,
    })
    expect(tickets).toHaveLength(0)
  })

  it("excludes another accountant's tickets", () => {
    const tickets = selectYesterdayTickets({
      problems: [ticket({ problem_id: 'x', accountant_id: 'emp-2', accountant_name: 'Other' })],
      chats: CHATS,
      access: ACC,
      now: NOW,
    })
    expect(tickets).toHaveLength(0)
  })

  it('excludes AI, false positives, and inactive chats', () => {
    const problems = [
      ticket({ problem_id: 'ai', source: 'ai' }),
      ticket({ problem_id: 'fp', verdict: 'not_problematic' }),
      ticket({ problem_id: 'inactive', chat_link: 'https://t.me/gone', contract_id: 'B-9' }),
    ]
    const chats = [
      ...CHATS,
      { agr_no: 'B-9', chat_link: 'https://t.me/gone', status: 'Inactive' },
    ]
    const tickets = selectYesterdayTickets({ problems, chats, access: ACC, now: NOW })
    expect(tickets).toHaveLength(0)
  })

  it('BLOCKS on an unknown chat when the ticket has a resolved accountant (stricter)', () => {
    // Chat not present in the directory at all → "unknown".
    const problems = [ticket({ problem_id: 'u1', chat_link: 'https://t.me/notlisted', contract_id: 'B-777' })]
    const tickets = selectYesterdayTickets({ problems, chats: CHATS, access: ACC, now: NOW })
    expect(tickets.map((t) => t.problem_id)).toEqual(['u1'])
  })

  it('does NOT block an unknown-chat ticket that has NO responsible accountant', () => {
    // Override after the helper (its `??` defaults would otherwise restore an id).
    const problems = [
      {
        ...ticket({ problem_id: 'u2', chat_link: 'https://t.me/notlisted', contract_id: 'B-778' }),
        accountant_id: null,
        accountant_name: null,
      },
    ]
    const tickets = selectYesterdayTickets({ problems, chats: CHATS, access: ACC, now: NOW })
    expect(tickets).toHaveLength(0)
  })
})

describe('Monday reaches back to Friday (previous working day)', () => {
  // Monday 2026-07-20, 13:00 Yerevan. Previous working day = Friday 2026-07-17.
  const MONDAY = new Date('2026-07-20T09:00:00Z')
  const FRIDAY = '2026-07-17T08:00:00Z' // 12:00 Yerevan, 17 July
  const SATURDAY = '2026-07-18T08:00:00Z'
  const SUNDAY = '2026-07-19T08:00:00Z'
  const THURSDAY = '2026-07-16T08:00:00Z' // day before Friday — must NOT block

  it("blocks on Friday's tickets when logging in Monday", () => {
    const tickets = selectYesterdayTickets({
      problems: [ticket({ problem_id: 'fri', detected_at: FRIDAY })],
      chats: CHATS,
      access: ACC,
      now: MONDAY,
    })
    expect(tickets.map((t) => t.problem_id)).toEqual(['fri'])
  })

  it('also blocks on weekend tickets (Sat/Sun) on Monday', () => {
    const tickets = selectYesterdayTickets({
      problems: [
        ticket({ problem_id: 'sat', detected_at: SATURDAY }),
        ticket({ problem_id: 'sun', detected_at: SUNDAY }),
      ],
      chats: CHATS,
      access: ACC,
      now: MONDAY,
    })
    expect(tickets.map((t) => t.problem_id).sort()).toEqual(['sat', 'sun'])
  })

  it('does NOT block on Thursday tickets (before the Friday window) on Monday', () => {
    const tickets = selectYesterdayTickets({
      problems: [ticket({ problem_id: 'thu', detected_at: THURSDAY })],
      chats: CHATS,
      access: ACC,
      now: MONDAY,
    })
    expect(tickets).toHaveLength(0)
  })
})

describe('answeredProblemIds', () => {
  it('unions acknowledgements and appeals', () => {
    const ids = answeredProblemIds([{ problem_id: 'a' }], [{ problem_id: 'b' }, { problem_id: 'a' }])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })
})

describe('computeGate', () => {
  // Distinct titles so dedup (source+chat+accountant+day+title) keeps them apart.
  const problems = [
    ticket({ problem_id: 'p1', problem_title: 'Проблема 1' }),
    ticket({ problem_id: 'p2', problem_title: 'Проблема 2' }),
    ticket({ problem_id: 'p3', problem_title: 'Проблема 3' }),
  ]

  it('blocks while any yesterday ticket is unanswered', () => {
    const g = computeGate({ problems, chats: CHATS, acks: [{ problem_id: 'p1' }], appeals: [], access: ACC, now: NOW })
    expect(g.total).toBe(3)
    expect(g.answered).toBe(1)
    expect(g.remaining).toBe(2)
    expect(g.complete).toBe(false)
    expect(isBlocked(g, ACC)).toBe(true)
  })

  it('clears once every ticket is accepted or appealed', () => {
    const g = computeGate({
      problems,
      chats: CHATS,
      acks: [{ problem_id: 'p1' }, { problem_id: 'p2' }],
      appeals: [{ problem_id: 'p3' }],
      access: ACC,
      now: NOW,
    })
    expect(g.complete).toBe(true)
    expect(g.remaining).toBe(0)
    expect(isBlocked(g, ACC)).toBe(false)
  })

  it('is not blocked when there are no yesterday tickets', () => {
    const g = computeGate({ problems: [], chats: CHATS, acks: [], appeals: [], access: ACC, now: NOW })
    expect(g.complete).toBe(true)
    expect(isBlocked(g, ACC)).toBe(false)
  })
})

describe('supervisor bypass', () => {
  it('never blocks a supervisor/manager even with unanswered tickets', () => {
    const g = computeGate({
      problems: [ticket({ problem_id: 'p1', accountant_id: 'emp-9', accountant_name: 'Boss' })],
      chats: CHATS,
      acks: [],
      appeals: [],
      access: BOSS,
      now: NOW,
    })
    // The supervisor may or may not have tickets, but the gate never applies.
    expect(isBlocked(g, BOSS)).toBe(false)
  })
})
