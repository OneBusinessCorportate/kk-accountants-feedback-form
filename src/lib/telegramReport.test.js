import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  reportVerdict,
  formatQualityReport,
  formatDailyReport,
  formatWeeklyReport,
} from './telegramReport'

const REPORT = {
  department: { accountants: 2, issues: 5, open: 3, urgent: 1, praise: 7, checkedBySona: 4, checkedByMargarita: 9 },
  byAccountant: [
    { accountantName: 'Анна', issues: 3, open: 2, urgent: 1, praise: 2 },
    { accountantName: 'Борис', issues: 2, open: 1, urgent: 0, praise: 5 },
  ],
}

describe('escapeHtml', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(escapeHtml(null)).toBe('')
  })
})

describe('reportVerdict — no empty day looks «хорошо»', () => {
  it('0 проверок → red «контроль НЕ проводился» (not a neutral empty)', () => {
    const v = reportVerdict({ checkedBySona: 0, checkedByMargarita: 0, issues: 0, open: 0, urgent: 0 })
    expect(v.key).toBe('no_control')
    expect(v.head).toBe('🔴')
    expect(v.title).toContain('НЕ проводился')
  })
  it('urgent > 0 → red «ОЧЕНЬ СРОЧНО»', () => {
    const v = reportVerdict({ checkedBySona: 4, checkedByMargarita: 0, issues: 5, open: 3, urgent: 1 })
    expect(v.key).toBe('urgent')
    expect(v.head).toBe('🔴')
  })
  it('open > 0 (no urgent) → orange', () => {
    const v = reportVerdict({ checkedBySona: 4, checkedByMargarita: 0, issues: 5, open: 2, urgent: 0 })
    expect(v.key).toBe('open')
    expect(v.head).toBe('🟠')
  })
  it('issues but all closed → yellow', () => {
    const v = reportVerdict({ checkedBySona: 4, checkedByMargarita: 0, issues: 5, open: 0, urgent: 0 })
    expect(v.key).toBe('resolved')
  })
  it('checks done, nothing open → GREEN is the only «good» state', () => {
    const v = reportVerdict({ checkedBySona: 4, checkedByMargarita: 2, issues: 0, open: 0, urgent: 0 })
    expect(v.key).toBe('clean')
    expect(v.head).toBe('🟢')
  })
})

describe('formatQualityReport', () => {
  it('leads with a verdict line and the reframed department block', () => {
    const msg = formatQualityReport({ report: REPORT, periodLabel: 'за сегодня' })
    expect(msg).toContain('за сегодня')
    expect(msg).toContain('ИТОГ:')
    expect(msg).toContain('Проверки: Сона 4, Маргарита 9')
    expect(msg).toContain('Открытых замечаний: <b>3</b> 🔴')
    expect(msg).toContain('Замечаний всего: 5 (устранено 2)')
    expect(msg).toContain('Похвал: 7')
  })

  it('an empty day reads as BAD — 0 проверок flagged with ❌ and ⛔️', () => {
    const msg = formatQualityReport({
      report: { department: { issues: 0, open: 0, urgent: 0, praise: 0, checkedBySona: 0, checkedByMargarita: 0 }, byAccountant: [] },
      periodLabel: 'за сегодня',
    })
    expect(msg).toContain('⛔️')
    expect(msg).toContain('контроль качества НЕ проводился')
    expect(msg).toContain('Сона 0 ❌')
    expect(msg).toContain('Маргарита 0 ❌')
    expect(msg.startsWith('🔴')).toBe(true)
  })

  it('puts «ОЧЕНЬ СРОЧНО» block when there are urgent issues', () => {
    const urgent = [
      { problem_title: 'Не сдан отчёт', client_name: 'ООО Ромашка', accountant_name: 'Анна' },
    ]
    const msg = formatQualityReport({ report: REPORT, urgent })
    expect(msg).toContain('ОЧЕНЬ СРОЧНО — 1')
    expect(msg).toContain('Не сдан отчёт')
    expect(msg).toContain('ООО Ромашка')
  })

  it('omits the urgent detail block when there is nothing urgent', () => {
    const msg = formatQualityReport({ report: REPORT, urgent: [] })
    expect(msg).not.toContain('ОЧЕНЬ СРОЧНО —')
  })

  it('lists accountants with flag emojis', () => {
    const msg = formatQualityReport({ report: REPORT })
    expect(msg).toContain('Анна: 🔴1 ⚠️3 👍2')
    expect(msg).toContain('Борис: ⚠️2 👍5')
  })

  it('escapes accountant / client names', () => {
    const msg = formatQualityReport({
      report: { department: { checkedBySona: 1 }, byAccountant: [{ accountantName: 'A & B <x>', issues: 1, praise: 0, urgent: 0 }] },
    })
    expect(msg).toContain('A &amp; B &lt;x&gt;')
  })

  it('adds the Sona work line when provided, with correct plural', () => {
    expect(formatQualityReport({ report: REPORT, sona: { companiesChecked: 1, problems: 0, clean: 1 } })).toContain(
      'проверено 1 компания',
    )
    expect(formatQualityReport({ report: REPORT, sona: { companiesChecked: 3, problems: 1, clean: 2 } })).toContain(
      'проверено 3 компании',
    )
    expect(formatQualityReport({ report: REPORT, sona: { companiesChecked: 5, problems: 0, clean: 5 } })).toContain(
      'проверено 5 компаний',
    )
  })
})

describe('cadence wrappers', () => {
  it('label daily / weekly', () => {
    expect(formatDailyReport({ report: REPORT })).toContain('за сегодня')
    expect(formatWeeklyReport({ report: REPORT })).toContain('за неделю')
  })
})
