import { describe, it, expect } from 'vitest'
import { occurrenceOnOrAfter, currentPeriod, expandSchedule } from '../../scripts/lib/schedule.mjs'

// Asia/Yerevan is UTC+4. A schedule time is Yerevan wall-clock; the produced
// instant must be that wall-clock minus 4h in UTC — NOT the process-local zone.
describe('occurrenceOnOrAfter (Yerevan → UTC)', () => {
  it('materialises 11:00 Yerevan on the 10th as 07:00 UTC', () => {
    const from = new Date('2026-07-01T00:00:00Z')
    const occ = occurrenceOnOrAfter(from, 10, 11, 0)
    expect(occ.toISOString()).toBe('2026-07-10T07:00:00.000Z')
  })
  it('rolls to next month when the day already passed', () => {
    const from = new Date('2026-07-20T00:00:00Z')
    const occ = occurrenceOnOrAfter(from, 5, 11, 0) // 5th already gone in July
    expect(occ.toISOString()).toBe('2026-08-05T07:00:00.000Z')
  })
  it('clamps day 31 to the month length (Feb)', () => {
    const from = new Date('2026-02-01T00:00:00Z')
    const occ = occurrenceOnOrAfter(from, 31, 11, 0)
    const p = new Date(occ.getTime() + 4 * 3600 * 1000) // back to Yerevan
    expect(p.getUTCMonth()).toBe(1) // February
    expect(p.getUTCDate()).toBe(28)
  })
  it('a 09:00 UTC "now" on the 5th still catches the 5th @ 11:00 Yerevan (07:00 UTC is earlier)', () => {
    // 07:00 UTC is BEFORE 09:00 UTC, so the same-day occurrence is in the past
    // → next month. Guards the "sender at 05:00 UTC misses today" class of bug.
    const from = new Date('2026-07-05T09:00:00Z')
    const occ = occurrenceOnOrAfter(from, 5, 11, 0)
    expect(occ.toISOString()).toBe('2026-08-05T07:00:00.000Z')
  })
})

describe('currentPeriod (Yerevan 28th cutoff)', () => {
  it('rolls on the 28th', () => {
    expect(currentPeriod('2026-07-23T09:00:00+04:00')).toBe('202607')
    expect(currentPeriod('2026-07-28T09:00:00+04:00')).toBe('202608')
    expect(currentPeriod('2026-12-29T09:00:00+04:00')).toBe('202701')
  })
})

describe('expandSchedule', () => {
  const today = new Date('2026-07-23T00:00:00Z')
  const rows = [
    { category: 'debts', subtype: 'service_payment', day_of_month: 5, enabled: true },
    { category: 'salary', subtype: 'table', day_of_month: 10, enabled: true },
    { category: 'main_taxes', subtype: 'report', day_of_month: 15, enabled: true },
    { category: 'primary_docs', subtype: 'request', day_of_month: 28, enabled: true },
    { category: 'debts', subtype: 'reminder', day_of_month: 5, enabled: false },
  ]
  it('includes ≥1 of every enabled category, skips disabled, sorted', () => {
    const chain = expandSchedule(rows, { today, horizonDays: 30 })
    const cats = new Set(chain.map((c) => c.category))
    expect(cats.has('debts') && cats.has('salary') && cats.has('main_taxes') && cats.has('primary_docs')).toBe(true)
    expect(chain.some((c) => c.subtype === 'reminder')).toBe(false)
    for (let i = 1; i < chain.length; i++) expect(chain[i].scheduledAt >= chain[i - 1].scheduledAt).toBe(true)
  })
})
