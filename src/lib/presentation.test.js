import { describe, it, expect } from 'vitest'
import {
  priorityBadgeClass,
  priorityLabel,
  problemContext,
  formatDate,
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
