import { describe, it, expect } from 'vitest'
import {
  priorityBadgeClass,
  priorityLabel,
  problemContext,
  formatDate,
  daysSince,
  formatAge,
  isOverdue,
  sortQueue,
} from './presentation'

describe('priority helpers', () => {
  it('maps each severity to a distinct badge color', () => {
    expect(priorityBadgeClass(1)).toBe('badge-red')
    expect(priorityBadgeClass(2)).toBe('badge-amber')
    expect(priorityBadgeClass(3)).toBe('badge-gray')
  })

  it('falls back to a neutral color for unknown priorities', () => {
    expect(priorityBadgeClass(99)).toBe('badge-blue')
  })

  it('labels known priorities and stringifies unknown ones', () => {
    expect(priorityLabel(1)).toBe('Высокий')
    expect(priorityLabel(7)).toBe('7')
    expect(priorityLabel(null)).toBe('')
  })
})

describe('problemContext', () => {
  it('merges description and ai_comment into one block', () => {
    const ctx = problemContext({
      problem_description: 'В расчёте аванса допущена неточность.',
      ai_comment: 'Найдено расхождение в сумме аванса.',
    })
    expect(ctx).toBe(
      'В расчёте аванса допущена неточность.\n\nНайдено расхождение в сумме аванса.',
    )
  })

  it('keeps the present part when one is missing', () => {
    expect(problemContext({ problem_description: 'Только описание.' })).toBe(
      'Только описание.',
    )
    expect(problemContext({ ai_comment: 'Только комментарий.' })).toBe(
      'Только комментарий.',
    )
  })

  it('returns empty string when there is nothing to show', () => {
    expect(problemContext({})).toBe('')
    expect(problemContext({ problem_description: '   ' })).toBe('')
  })

  it('never leaks the source / reviewer into the context', () => {
    const ctx = problemContext({
      problem_description: 'Описание',
      ai_comment: 'Комментарий',
      source: 'sona_review',
    })
    expect(ctx).not.toContain('sona')
    expect(ctx).not.toContain('review')
  })
})

describe('formatDate', () => {
  it('formats an ISO timestamp as a ru-RU date', () => {
    expect(formatDate('2026-06-22T10:30:00Z')).toBe('22.06.2026')
  })

  it('returns empty string for missing or invalid input', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDate(undefined)).toBe('')
    expect(formatDate('not-a-date')).toBe('')
  })
})

describe('aging', () => {
  const now = new Date('2026-06-22T12:00:00Z')

  it('counts whole days waited', () => {
    expect(daysSince('2026-06-22T00:00:00Z', now)).toBe(0)
    expect(daysSince('2026-06-20T12:00:00Z', now)).toBe(2)
    expect(daysSince(null, now)).toBeNull()
    expect(daysSince('nonsense', now)).toBeNull()
  })

  it('renders a human age with correct russian plurals', () => {
    expect(formatAge('2026-06-22T08:00:00Z', now)).toBe('сегодня')
    expect(formatAge('2026-06-21T08:00:00Z', now)).toBe('вчера')
    expect(formatAge('2026-06-19T08:00:00Z', now)).toBe('3 дня назад')
    expect(formatAge('2026-06-14T08:00:00Z', now)).toBe('8 дней назад')
    expect(formatAge('2026-06-01T08:00:00Z', now)).toBe('21 день назад')
  })
})

describe('isOverdue', () => {
  const now = new Date('2026-06-22T12:00:00Z')

  it('uses a tighter response target for higher priority', () => {
    // High priority breaches after 1 day.
    expect(isOverdue({ priority: 1, detected_at: '2026-06-21T08:00:00Z' }, now)).toBe(true)
    expect(isOverdue({ priority: 1, detected_at: '2026-06-22T08:00:00Z' }, now)).toBe(false)
    // Low priority gets a week.
    expect(isOverdue({ priority: 3, detected_at: '2026-06-19T08:00:00Z' }, now)).toBe(false)
    expect(isOverdue({ priority: 3, detected_at: '2026-06-10T08:00:00Z' }, now)).toBe(true)
  })

  it('is false when there is no date to age from', () => {
    expect(isOverdue({ priority: 1 }, now)).toBe(false)
  })
})

describe('sortQueue', () => {
  it('orders by priority, then oldest first, without mutating input', () => {
    const input = [
      { problem_id: 'a', priority: 2, detected_at: '2026-06-20T00:00:00Z' },
      { problem_id: 'b', priority: 1, detected_at: '2026-06-21T00:00:00Z' },
      { problem_id: 'c', priority: 1, detected_at: '2026-06-19T00:00:00Z' },
      { problem_id: 'd', priority: 3, detected_at: '2026-06-18T00:00:00Z' },
    ]
    const order = sortQueue(input).map((p) => p.problem_id)
    expect(order).toEqual(['c', 'b', 'a', 'd'])
    // original array untouched
    expect(input.map((p) => p.problem_id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('falls back to created_at and pushes missing priorities last', () => {
    const input = [
      { problem_id: 'x', created_at: '2026-06-20T00:00:00Z' },
      { problem_id: 'y', priority: 2, created_at: '2026-06-21T00:00:00Z' },
    ]
    expect(sortQueue(input).map((p) => p.problem_id)).toEqual(['y', 'x'])
  })
})
