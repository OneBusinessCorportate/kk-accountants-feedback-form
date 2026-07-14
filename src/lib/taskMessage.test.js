import { describe, it, expect } from 'vitest'
import {
  buildTaskMessage,
  taskEmoji,
  taskLabel,
  taskStatusOf,
  TASK_PROGRESS,
} from './taskMessage'

describe('taskStatusOf', () => {
  it('uses the explicit status when present', () => {
    expect(taskStatusOf({ status: 'in_progress' })).toBe('in_progress')
  })
  it('falls back to the legacy done boolean', () => {
    expect(taskStatusOf({ done: true })).toBe('done')
    expect(taskStatusOf({ done: false })).toBe('open')
  })
  it('defaults to open for an unknown/empty task', () => {
    expect(taskStatusOf(null)).toBe('open')
    expect(taskStatusOf({})).toBe('open')
  })
})

describe('taskEmoji', () => {
  it('maps done → 🟢, in_progress → ⭕, not-done → 🔴', () => {
    expect(taskEmoji({ status: 'done' })).toBe('🟢')
    expect(taskEmoji({ status: 'in_progress' })).toBe('⭕')
    expect(taskEmoji({ status: 'open' })).toBe('🔴')
    expect(taskEmoji({ status: 'postponed' })).toBe('🔴')
  })
})

describe('taskLabel', () => {
  it('prefers the title', () => {
    expect(taskLabel({ title: 'հաշիվ գրել', client_name: 'ACME' })).toBe('հաշիվ գրել')
  })
  it('falls back to the client name, then a default', () => {
    expect(taskLabel({ client_name: 'ACME' })).toBe('ACME')
    expect(taskLabel({})).toBe('Задача')
  })
})

describe('buildTaskMessage', () => {
  it('renders the required format with a header and per-status indicators', () => {
    const msg = buildTaskMessage([
      { title: 'հաշիվ գրել', status: 'done' },
      { title: 'փոխանցում անել', status: 'open' },
      { title: 'Проверить документы клиента', status: 'in_progress' },
    ])
    expect(msg).toBe(
      ['Задачи:', '🟢 հաշիվ գրել', '🔴 փոխանցում անել', '⭕ Проверить документы клиента'].join('\n'),
    )
  })

  it('omits cancelled tasks (they are no longer to-dos)', () => {
    const msg = buildTaskMessage([
      { title: 'A', status: 'done' },
      { title: 'B', status: 'cancelled' },
    ])
    expect(msg).toBe('Задачи:\n🟢 A')
  })

  it('returns an empty string when there is nothing to report', () => {
    expect(buildTaskMessage([])).toBe('')
    expect(buildTaskMessage([{ title: 'X', status: 'cancelled' }])).toBe('')
  })

  it('updates as statuses change (recomputed from input)', () => {
    const tasks = [{ title: 'T', status: 'open' }]
    expect(buildTaskMessage(tasks)).toBe('Задачи:\n🔴 T')
    tasks[0].status = 'done'
    expect(buildTaskMessage(tasks)).toBe('Задачи:\n🟢 T')
  })
})

describe('TASK_PROGRESS', () => {
  it('exposes exactly the three required states', () => {
    expect(TASK_PROGRESS.map((p) => p.status)).toEqual(['done', 'in_progress', 'open'])
    expect(TASK_PROGRESS.map((p) => p.emoji)).toEqual(['🟢', '⭕', '🔴'])
  })
})
