import { describe, it, expect } from 'vitest'
import {
  WILL_SEND_WARNING,
  categoryLabel,
  modeLabel,
  statusLabel,
  isSendable,
  willBeSent,
  willActuallySend,
  needsAttachment,
  groupByDay,
  sendableCount,
} from './notifications'

describe('WILL_SEND_WARNING', () => {
  it('explicitly warns the message WILL be sent', () => {
    expect(WILL_SEND_WARNING).toMatch(/БУДЕТ отправлено/)
  })
})

describe('labels', () => {
  it('maps known categories/modes/statuses and falls back for unknown', () => {
    expect(categoryLabel('salary')).toMatch(/Зарплата/)
    expect(categoryLabel('mystery')).toBe('mystery')
    expect(modeLabel('auto')).toBe('Автоматически')
    expect(modeLabel('manual')).toMatch(/файл/)
    expect(statusLabel('planned')).toBe('Запланировано')
    expect(statusLabel('nope')).toBe('nope')
  })
})

describe('isSendable / willBeSent', () => {
  it('planned/edited/approved send; cancelled/sent/skipped do not', () => {
    expect(isSendable('planned')).toBe(true)
    expect(isSendable('edited')).toBe(true)
    expect(isSendable('approved')).toBe(true)
    expect(isSendable('cancelled')).toBe(false)
    expect(isSendable('sent')).toBe(false)
    expect(isSendable('skipped')).toBe(false)
    expect(willBeSent({ status: 'planned' })).toBe(true)
    expect(willBeSent({ status: 'cancelled' })).toBe(false)
    expect(willBeSent(null)).toBe(false)
  })
})

describe('needsAttachment', () => {
  const manualRow = { mode: 'manual', requires_attachment: true }
  it('a manual row with no file/mark still needs an attachment', () => {
    expect(needsAttachment(manualRow, undefined)).toBe(true)
    expect(needsAttachment(manualRow, { file_url: '', marked_done: false })).toBe(true)
  })
  it('is satisfied by a file or a mark-done', () => {
    expect(needsAttachment(manualRow, { file_url: 'x.pdf' })).toBe(false)
    expect(needsAttachment(manualRow, { marked_done: true })).toBe(false)
  })
  it('auto rows never need an attachment', () => {
    expect(needsAttachment({ mode: 'auto', requires_attachment: false }, undefined)).toBe(false)
  })
})

describe('groupByDay (manager daily overview)', () => {
  it('groups by scheduled day, sorts days ascending and rows by contract/category', () => {
    const planned = [
      { agr_no: 'B-2', category: 'salary', scheduled_date: '2026-07-10', status: 'planned' },
      { agr_no: 'B-1', category: 'debts', scheduled_date: '2026-07-10', status: 'edited' },
      { agr_no: 'B-1', category: 'main_taxes', scheduled_date: '2026-07-05', status: 'cancelled' },
    ]
    const days = groupByDay(planned)
    expect(days.map((d) => d.date)).toEqual(['2026-07-05', '2026-07-10'])
    expect(days[1].rows.map((r) => r.agr_no)).toEqual(['B-1', 'B-2'])
  })
  it('ignores rows without a scheduled date', () => {
    expect(groupByDay([{ agr_no: 'x', scheduled_date: null }])).toEqual([])
  })
})

describe('willActuallySend (manual rows need their attachment)', () => {
  const manual = { status: 'planned', mode: 'manual', requires_attachment: true, agr_no: 'B-1', period: '202607', category: 'salary' }
  const auto = { status: 'planned', mode: 'auto', requires_attachment: false }
  it('a manual row WITHOUT its attachment will NOT be sent, even if status is sendable', () => {
    expect(isSendable(manual.status)).toBe(true) // status alone says sendable...
    expect(willActuallySend(manual, undefined)).toBe(false) // ...but it is held
    expect(willActuallySend(manual, { marked_done: false })).toBe(false)
  })
  it('a manual row WITH a file / mark-done will be sent', () => {
    expect(willActuallySend(manual, { file_url: 'v.pdf' })).toBe(true)
    expect(willActuallySend(manual, { marked_done: true })).toBe(true)
  })
  it('an auto row is sent purely on status', () => {
    expect(willActuallySend(auto, undefined)).toBe(true)
    expect(willActuallySend({ ...auto, status: 'cancelled' }, undefined)).toBe(false)
  })
})

describe('sendableCount', () => {
  it('excludes manual rows still missing their attachment', () => {
    const rows = [
      { status: 'planned', mode: 'auto', requires_attachment: false, agr_no: 'B-1', period: '202607', category: 'debts' },
      { status: 'planned', mode: 'manual', requires_attachment: true, agr_no: 'B-1', period: '202607', category: 'salary' },
      { status: 'cancelled', mode: 'auto', requires_attachment: false, agr_no: 'B-2', period: '202607', category: 'debts' },
    ]
    // no attachments known → the manual salary row is held, only the auto row counts
    expect(sendableCount(rows)).toBe(1)
    // with the salary attachment present → both sendable rows count
    const att = new Map([['B-1|202607|salary', { file_url: 'v.pdf' }]])
    expect(sendableCount(rows, att)).toBe(2)
  })
})
