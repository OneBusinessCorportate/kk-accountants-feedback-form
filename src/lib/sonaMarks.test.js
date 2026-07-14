import { describe, it, expect } from 'vitest'
import {
  SONA_SOURCE,
  isDismissed,
  markInfo,
  toMark,
  groupSonaMarks,
  summarizeSonaMarks,
} from './sonaMarks'

const problems = [
  {
    problem_id: 's1',
    source: 'sona_review',
    accountant_id: 'a1',
    accountant_name: 'Анна',
    status: 'waiting_for_accountant',
    priority: 2,
    detected_at: '2026-07-01T09:00:00Z',
    problem_title: 'Ошибка в расчёте НДС',
    problem_description: 'Неверно посчитан НДС по счёту №42.',
    client_name: 'ООО Ромашка',
    contract_id: 'B-100',
    chat_link: 'https://chat/1',
  },
  {
    problem_id: 's2',
    source: 'sona_review',
    accountant_id: 'a1',
    accountant_name: 'Анна',
    status: 'acknowledged',
    priority: 1,
    detected_at: '2026-07-03T09:00:00Z',
    problem_title: 'Пропущен срок сдачи отчёта',
  },
  {
    problem_id: 's3',
    source: 'sona_review',
    accountant_id: 'a2',
    accountant_name: 'Борис',
    status: 'waiting_for_accountant',
    priority: 2,
    detected_at: '2026-07-02T09:00:00Z',
    problem_title: 'Некорректная проводка',
    verdict: 'not_problematic',
  },
  // Not a Sona mark — must be ignored entirely.
  {
    problem_id: 'm1',
    source: 'margarita_review',
    accountant_id: 'a1',
    accountant_name: 'Анна',
    status: 'new',
    problem_title: 'Поздний ответ',
  },
  // Unresolved accountant — kept under a «Не назначено» group.
  {
    problem_id: 's4',
    source: 'sona_review',
    accountant_id: null,
    accountant_name: null,
    status: 'waiting_for_accountant',
    problem_title: 'Проблема по проверке качества',
  },
]

describe('isDismissed', () => {
  it('is true only for a false-positive verdict', () => {
    expect(isDismissed({ verdict: 'not_problematic' })).toBe(true)
    expect(isDismissed({ verdict: 'problematic' })).toBe(false)
    expect(isDismissed({})).toBe(false)
  })
})

describe('markInfo', () => {
  it('uses the description as the mistake detail', () => {
    expect(markInfo(problems[0])).toContain('Неверно посчитан НДС')
  })
  it('falls back to the title when there is no description', () => {
    expect(markInfo(problems[1])).toBe('Пропущен срок сдачи отчёта')
  })
  it('never returns empty', () => {
    expect(markInfo({})).toBe('Без описания.')
  })
})

describe('toMark', () => {
  it('normalises a problem into a compact mark', () => {
    const m = toMark(problems[0])
    expect(m).toMatchObject({
      problem_id: 's1',
      title: 'Ошибка в расчёте НДС',
      client_name: 'ООО Ромашка',
      contract_id: 'B-100',
      chat_link: 'https://chat/1',
      priority: 2,
      status: 'waiting_for_accountant',
      dismissed: false,
    })
    expect(m.info).toContain('Неверно посчитан НДС')
  })
})

describe('groupSonaMarks', () => {
  it('keeps only sona_review rows', () => {
    const groups = groupSonaMarks(problems)
    const allIds = groups.flatMap((g) => g.marks.map((m) => m.problem_id))
    expect(allIds).not.toContain('m1')
  })

  it('groups by accountant with total and active counts', () => {
    const groups = groupSonaMarks(problems)
    const anna = groups.find((g) => g.accountantId === 'a1')
    expect(anna.total).toBe(2)
    expect(anna.active).toBe(2)

    const boris = groups.find((g) => g.accountantId === 'a2')
    // s3 is a dismissed false positive → counted in total, not in active.
    expect(boris.total).toBe(1)
    expect(boris.active).toBe(0)
  })

  it('keeps an unresolved accountant under a «Не назначено» group', () => {
    const groups = groupSonaMarks(problems)
    const none = groups.find((g) => g.accountantId === null)
    expect(none.accountantName).toBe('— Не назначено —')
    expect(none.marks.map((m) => m.problem_id)).toEqual(['s4'])
  })

  it('orders each accountant’s marks newest first', () => {
    const groups = groupSonaMarks(problems)
    const anna = groups.find((g) => g.accountantId === 'a1')
    expect(anna.marks.map((m) => m.problem_id)).toEqual(['s2', 's1'])
  })

  it('orders groups by active-mark count, then name', () => {
    const groups = groupSonaMarks(problems)
    expect(groups[0].accountantId).toBe('a1') // Анна: 2 active
  })

  it('returns an empty array for no input', () => {
    expect(groupSonaMarks()).toEqual([])
  })
})

describe('summarizeSonaMarks', () => {
  it('totals accountants, marks and active marks', () => {
    const groups = groupSonaMarks(problems)
    expect(summarizeSonaMarks(groups)).toEqual({ accountants: 3, total: 4, active: 3 })
  })
  it('handles no groups', () => {
    expect(summarizeSonaMarks()).toEqual({ accountants: 0, total: 0, active: 0 })
  })
})

describe('SONA_SOURCE', () => {
  it('is the sona_review source key', () => {
    expect(SONA_SOURCE).toBe('sona_review')
  })
})
