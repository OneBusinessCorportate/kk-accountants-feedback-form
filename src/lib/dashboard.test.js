import { describe, it, expect } from 'vitest'
import {
  isDashboardSource,
  cleanClientName,
  clientKey,
  normalizeContract,
  normalizeChatLink,
  buildChatIndex,
  chatActivity,
  hasResponsibleAccountant,
  categoryOf,
  isSlaProblem,
  dedupKey,
  dedupeProblems,
  periodStart,
  inPeriod,
  formatDate,
  businessMinutesBetween,
  businessHoursBetween,
  isOverdue,
  prepareDashboard,
  groupClients,
  CATEGORY,
} from './dashboard'

const CHATS = [
  { chat_link: 'https://web.telegram.org/a/#-100', agr_no: 'B-100', status: 'Active ' },
  { chat_link: 'https://web.telegram.org/a/#-200', agr_no: 'B-200', status: 'Inactive' },
  { chat_link: 'https://web.telegram.org/a/#-300', agr_no: '300', status: 'Active' },
]

function problem(over = {}) {
  return {
    problem_id: 'margarita:1',
    source: 'margarita_review',
    client_name: 'Acme LLC',
    contract_id: 'B-100',
    chat_link: 'https://web.telegram.org/a/#-100',
    accountant_id: 'emp-1',
    accountant_name: 'Gayane Abgaryan',
    priority: 2,
    problem_title: 'Нарушение (Маргарита)',
    detected_at: '2026-07-08T09:00:00Z',
    status: 'waiting_for_accountant',
    verdict: null,
    ...over,
  }
}

describe('source filtering (no AI)', () => {
  it('accepts only margarita_review and sona_review', () => {
    expect(isDashboardSource({ source: 'margarita_review' })).toBe(true)
    expect(isDashboardSource({ source: 'sona_review' })).toBe(true)
    expect(isDashboardSource({ source: 'ai' })).toBe(false)
    expect(isDashboardSource({ source: 'manual' })).toBe(false)
  })
})

describe('client name normalisation', () => {
  it('trims and collapses whitespace but keeps casing for display', () => {
    expect(cleanClientName('  Acme   LLC ')).toBe('Acme LLC')
    expect(cleanClientName(null)).toBe('')
  })
  it('keys are case-insensitive so the same client collapses', () => {
    expect(clientKey(' Acme LLC ')).toBe(clientKey('acme  llc'))
  })
})

describe('contract / link normalisation', () => {
  it('unifies Cyrillic/Latin and spacing in contract numbers', () => {
    expect(normalizeContract('В-100')).toBe('B-100')
    expect(normalizeContract('№ Н-100')).toBe('N-100')
  })
  it('normalises chat links', () => {
    expect(normalizeChatLink('HTTPS://web.telegram.org/a/#-100/')).toBe(
      'https://web.telegram.org/a/#-100',
    )
  })
})

describe('active-chat index (kk-soprovozhdeniya)', () => {
  const index = buildChatIndex(CHATS)
  it('marks a chat active by link or contract', () => {
    expect(chatActivity(problem(), index)).toBe('active')
    expect(chatActivity(problem({ chat_link: null, contract_id: '300' }), index)).toBe('active')
  })
  it('marks a known-but-inactive chat inactive', () => {
    expect(
      chatActivity(problem({ chat_link: 'https://web.telegram.org/a/#-200', contract_id: 'B-200' }), index),
    ).toBe('inactive')
  })
  it('marks an unmatched chat unknown', () => {
    expect(chatActivity(problem({ chat_link: 'https://x/#-999', contract_id: 'ZZ' }), index)).toBe(
      'unknown',
    )
  })
  it('treats everything as unknown without an index', () => {
    expect(chatActivity(problem(), null)).toBe('unknown')
  })
})

describe('responsible accountant', () => {
  it('requires a resolved accountant id', () => {
    expect(hasResponsibleAccountant(problem())).toBe(true)
    expect(hasResponsibleAccountant(problem({ accountant_id: null }))).toBe(false)
    expect(hasResponsibleAccountant(problem({ accountant_id: '  ' }))).toBe(false)
  })
})

describe('categories and SLA tag', () => {
  it('classifies quality evaluations, violations and sona', () => {
    expect(categoryOf(problem({ problem_title: 'Критичная оценка качества сервиса' }))).toBe(
      CATEGORY.quality,
    )
    expect(categoryOf(problem({ problem_title: 'Нарушение (Маргарита)' }))).toBe(CATEGORY.violation)
    expect(categoryOf(problem({ source: 'sona_review' }))).toBe(CATEGORY.sona)
  })
  it('flags timing/SLA problems only for Margarita', () => {
    expect(isSlaProblem(problem({ problem_title: 'Нарушение обещанных сроков ответа' }))).toBe(true)
    expect(isSlaProblem(problem({ problem_title: 'Несвоевременная обратная связь по задачам' }))).toBe(
      true,
    )
    expect(isSlaProblem(problem({ problem_title: 'Ошибка в отправленном инвойсе' }))).toBe(false)
    expect(
      isSlaProblem(problem({ source: 'sona_review', problem_title: 'Нарушение сроков' })),
    ).toBe(false)
  })
})

describe('dedup', () => {
  it('collapses identical source+chat+accountant+day+title rows', () => {
    const a = problem({ problem_id: 'margarita:1' })
    const b = problem({ problem_id: 'margarita:2' }) // same chat/acc/day/title
    expect(dedupKey(a)).toBe(dedupKey(b))
    const out = dedupeProblems([a, b])
    expect(out).toHaveLength(1)
  })
  it('keeps genuinely different problems and records sources', () => {
    const a = problem()
    const b = problem({ source: 'sona_review', problem_id: 'sona:9', problem_title: 'Проблема' })
    const out = dedupeProblems([a, b])
    expect(out).toHaveLength(2)
  })
})

describe('date periods (req 3)', () => {
  const now = new Date('2026-07-08T12:00:00Z') // 16:00 Yerevan
  it('today = start of the local day', () => {
    const start = periodStart('today', now)
    // 2026-07-08 00:00 Yerevan == 2026-07-07T20:00:00Z
    expect(start.toISOString()).toBe('2026-07-07T20:00:00.000Z')
  })
  it('all = no lower bound', () => {
    expect(periodStart('all', now)).toBeNull()
  })
  it('filters problems by detected_at', () => {
    expect(inPeriod(problem({ detected_at: '2026-07-08T09:00:00Z' }), 'today', now)).toBe(true)
    expect(inPeriod(problem({ detected_at: '2026-07-01T09:00:00Z' }), 'today', now)).toBe(false)
    expect(inPeriod(problem({ detected_at: '2026-07-01T09:00:00Z' }), 'all', now)).toBe(true)
    expect(inPeriod(problem({ detected_at: '2026-07-03T09:00:00Z' }), 'week', now)).toBe(true)
  })
})

describe('date display in Yerevan tz', () => {
  it('shows the local calendar date', () => {
    // 2026-07-07T21:00:00Z == 2026-07-08 01:00 Yerevan
    expect(formatDate('2026-07-07T21:00:00Z')).toBe('08.07.2026')
    expect(formatDate(null)).toBe('')
  })
})

describe('working-hours SLA (10–13, 14–19 Yerevan)', () => {
  // Yerevan is UTC+4. 10:00 local = 06:00Z, 13:00 = 09:00Z, 14:00 = 10:00Z, 19:00 = 15:00Z.
  it('counts only inside the windows, excluding lunch', () => {
    // full working day 10:00–19:00 local = 3h + 5h = 8 hours
    expect(businessHoursBetween('2026-07-06T06:00:00Z', '2026-07-06T15:00:00Z')).toBe(8)
  })
  it('excludes the lunch hour', () => {
    // 12:00–15:00 local (08:00Z–11:00Z): 12–13 (1h) + lunch + 14–15 (1h) = 2h
    expect(businessHoursBetween('2026-07-06T08:00:00Z', '2026-07-06T11:00:00Z')).toBe(2)
  })
  it('a message after 19:00 starts the next working morning', () => {
    // 20:00 local Mon (16:00Z) → next day 10:00–11:00 local (06:00Z–07:00Z) = 1h window used
    const mins = businessMinutesBetween('2026-07-06T16:00:00Z', '2026-07-07T07:00:00Z')
    expect(mins).toBe(60)
  })
  it('a message inside lunch effectively starts at 14:00', () => {
    // 13:30 local (09:30Z) to 15:00 local (11:00Z): only 14:00–15:00 counts = 1h
    expect(businessHoursBetween('2026-07-06T09:30:00Z', '2026-07-06T11:00:00Z')).toBe(1)
  })
  it('overdue uses the working-hours target per priority', () => {
    const detected = '2026-07-06T06:00:00Z' // Mon 10:00 local
    // 8 working hours later = Mon 19:00 local (15:00Z). Priority 1 target = 8h → not yet over.
    expect(isOverdue(problem({ priority: 1, detected_at: detected }), new Date('2026-07-06T15:00:00Z'))).toBe(
      false,
    )
    // next working day +1h → 9 working hours > 8 target → overdue
    expect(
      isOverdue(problem({ priority: 1, detected_at: detected }), new Date('2026-07-07T07:00:00Z')),
    ).toBe(true)
  })
})

describe('prepareDashboard end to end', () => {
  const now = new Date('2026-07-08T12:00:00Z')
  it('drops AI, hides inactive, routes unmatched/unassigned to needs review', () => {
    const rows = [
      problem({ problem_id: 'ai:1', source: 'ai' }), // dropped (AI)
      problem({ problem_id: 'fp:1', verdict: 'not_problematic' }), // dropped (false positive)
      problem({ problem_id: 'inactive:1', chat_link: 'https://web.telegram.org/a/#-200', contract_id: 'B-200' }), // hidden
      problem({ problem_id: 'unknown:1', chat_link: 'https://x/#-9', contract_id: 'ZZ' }), // needs review (unknown chat)
      problem({ problem_id: 'noacc:1', accountant_id: null }), // needs review (no accountant)
      problem({ problem_id: 'ok:1' }), // active
      problem({ problem_id: 'ok:2', source: 'sona_review', problem_title: 'Проблема' }), // active sona
    ]
    const r = prepareDashboard({ problems: rows, chats: CHATS, period: 'all', now })
    expect(r.active.map((p) => p.problem_id).sort()).toEqual(['ok:1', 'ok:2'])
    expect(r.needsReview.map((p) => p.problem_id).sort()).toEqual(['noacc:1', 'unknown:1'])
    expect(r.hidden.map((p) => p.problem_id)).toEqual(['inactive:1'])
    expect(r.counts.total).toBe(2)
    expect(r.counts.sona).toBe(1)
    expect(r.counts.violation).toBe(1)
  })

  it('respects the date period', () => {
    const rows = [
      problem({ problem_id: 'old', detected_at: '2026-01-01T09:00:00Z' }),
      problem({ problem_id: 'new', detected_at: '2026-07-08T09:00:00Z' }),
    ]
    const today = prepareDashboard({ problems: rows, chats: CHATS, period: 'today', now })
    expect(today.active.map((p) => p.problem_id)).toEqual(['new'])
    const all = prepareDashboard({ problems: rows, chats: CHATS, period: 'all', now })
    expect(all.active).toHaveLength(2)
  })
})

describe('groupClients (no duplicate clients)', () => {
  it('one row per client, merging chats and sources', () => {
    const rows = [
      problem({ problem_id: 'a', client_name: 'Acme LLC' }),
      problem({ problem_id: 'b', client_name: ' acme  llc ', source: 'sona_review' }),
      problem({ problem_id: 'c', client_name: 'Beta' }),
    ]
    const clients = groupClients(rows)
    expect(clients).toHaveLength(2)
    const acme = clients.find((c) => c.key === 'acme llc')
    expect(acme.problems).toHaveLength(2)
    expect(acme.sources.sort()).toEqual(['margarita_review', 'sona_review'])
    expect(acme.chats).toHaveLength(1)
  })
})
