import { describe, it, expect } from 'vitest'
import {
  STATUS,
  STATUS_LABELS,
  SOURCES,
  SOURCE_LABELS,
  ACCOUNTANT_ACTIONABLE,
  REVIEW_QUEUE,
  PRIORITY_LABELS,
} from './constants'

describe('constants integrity', () => {
  it('every status has a human label', () => {
    for (const s of Object.values(STATUS)) {
      expect(STATUS_LABELS[s], `missing label for status "${s}"`).toBeTruthy()
    }
  })

  it('every source has a human label', () => {
    for (const s of SOURCES) {
      expect(SOURCE_LABELS[s], `missing label for source "${s}"`).toBeTruthy()
    }
  })

  it('accountant + review queues only reference real statuses', () => {
    const valid = new Set(Object.values(STATUS))
    for (const s of [...ACCOUNTANT_ACTIONABLE, ...REVIEW_QUEUE]) {
      expect(valid.has(s), `unknown status "${s}" in a queue`).toBe(true)
    }
  })

  it('covers the three priority levels', () => {
    expect(Object.keys(PRIORITY_LABELS).sort()).toEqual(['1', '2', '3'])
  })
})
