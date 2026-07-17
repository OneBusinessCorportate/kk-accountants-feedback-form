import { describe, it, expect } from 'vitest'
import {
  isConfirmedTicket,
  confirmedTickets,
  sanctionOf,
  isCancelledViolation,
  summarizeMyViolations,
} from './violationReport'

describe('isConfirmedTicket / confirmedTickets (req 1: confirmed <> false)', () => {
  it('keeps TRUE and NULL/undefined, drops only explicit FALSE', () => {
    expect(isConfirmedTicket({ confirmed: true })).toBe(true)
    expect(isConfirmedTicket({ confirmed: null })).toBe(true)
    expect(isConfirmedTicket({})).toBe(true)
    expect(isConfirmedTicket({ confirmed: false })).toBe(false)
  })

  it('filters a set to confirmed-only', () => {
    const rows = [
      { violation_id: '1', confirmed: true },
      { violation_id: '2', confirmed: false },
      { violation_id: '3' },
    ]
    expect(confirmedTickets(rows).map((r) => r.violation_id)).toEqual(['1', '3'])
  })
})

describe('sanctionOf', () => {
  it('parses a number, defaults to 0', () => {
    expect(sanctionOf({ sanction: 5000 })).toBe(5000)
    expect(sanctionOf({ sanction: '2500' })).toBe(2500)
    expect(sanctionOf({ sanction: null })).toBe(0)
    expect(sanctionOf({})).toBe(0)
    expect(sanctionOf({ sanction: 'abc' })).toBe(0)
  })
})

describe('isCancelledViolation', () => {
  it('is cancelled only after an approved appeal', () => {
    expect(isCancelledViolation({ status: 'appeal_approved' })).toBe(true)
    expect(isCancelledViolation({ status: 'appeal_rejected' })).toBe(false)
    expect(isCancelledViolation({ status: 'new' })).toBe(false)
    expect(isCancelledViolation({})).toBe(false)
  })
})

describe('summarizeMyViolations (req 4: self mini-report)', () => {
  it('counts an empty set as all zeros', () => {
    expect(summarizeMyViolations([])).toEqual({
      received: 0,
      acknowledged: 0,
      appealsFiled: 0,
      approved: 0,
      rejected: 0,
      pending: 0,
      activeViolations: 0,
      cancelledViolations: 0,
      finesActive: 0,
      finesCancelled: 0,
    })
  })

  it('excludes confirmed = false from every metric', () => {
    const rows = [
      { violation_id: '1', status: 'new', sanction: 1000 },
      { violation_id: '2', status: 'new', sanction: 9999, confirmed: false },
    ]
    const r = summarizeMyViolations(rows)
    expect(r.received).toBe(1)
    expect(r.finesActive).toBe(1000)
  })

  it('counts acknowledgement by acknowledged_at even after an appeal', () => {
    const rows = [
      { violation_id: '1', status: 'acknowledged' },
      { violation_id: '2', status: 'appealed', acknowledged_at: '2026-07-10T10:00:00Z', appeal_id: 'a2', appeal_status: 'pending' },
      { violation_id: '3', status: 'new' },
    ]
    const r = summarizeMyViolations(rows)
    expect(r.acknowledged).toBe(2)
    expect(r.received).toBe(3)
  })

  it('buckets appeals by the latest outcome (pending / approved / rejected)', () => {
    const rows = [
      { violation_id: '1', status: 'appealed', appeal_id: 'a1', appeal_status: 'pending' },
      { violation_id: '2', status: 'appeal_approved', appeal_id: 'a2', appeal_status: 'approved' },
      { violation_id: '3', status: 'appeal_rejected', appeal_id: 'a3', appeal_status: 'rejected' },
      { violation_id: '4', status: 'new' },
    ]
    const r = summarizeMyViolations(rows)
    expect(r.appealsFiled).toBe(3)
    expect(r.pending).toBe(1)
    expect(r.approved).toBe(1)
    expect(r.rejected).toBe(1)
  })

  it('infers appeal state from status even if appeal_status is missing', () => {
    const rows = [{ violation_id: '1', status: 'appeal_approved' }]
    const r = summarizeMyViolations(rows)
    expect(r.appealsFiled).toBe(1)
    expect(r.approved).toBe(1)
  })

  it('splits violations and fines active vs cancelled after an approved appeal', () => {
    const rows = [
      { violation_id: '1', status: 'new', sanction: 1000 },
      { violation_id: '2', status: 'appeal_rejected', appeal_id: 'a2', appeal_status: 'rejected', sanction: 2000 },
      { violation_id: '3', status: 'appeal_approved', appeal_id: 'a3', appeal_status: 'approved', sanction: 3000 },
    ]
    const r = summarizeMyViolations(rows)
    // active = new + appeal_rejected; cancelled = appeal_approved
    expect(r.activeViolations).toBe(2)
    expect(r.cancelledViolations).toBe(1)
    expect(r.finesActive).toBe(3000) // 1000 + 2000
    expect(r.finesCancelled).toBe(3000)
  })
})
