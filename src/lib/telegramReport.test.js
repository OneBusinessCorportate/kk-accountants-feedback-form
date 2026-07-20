import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  formatQualityReport,
  formatDailyReport,
  formatWeeklyReport,
} from './telegramReport'

const REPORT = {
  department: { accountants: 2, issues: 5, open: 3, praise: 7, checkedBySona: 4, checkedByMargarita: 9 },
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

describe('formatQualityReport', () => {
  it('renders the department summary', () => {
    const msg = formatQualityReport({ report: REPORT, periodLabel: 'за сегодня' })
    expect(msg).toContain('за сегодня')
    expect(msg).toContain('Замечаний: <b>5</b> (открыто 3)')
    expect(msg).toContain('Похвал: <b>7</b>')
    expect(msg).toContain('Сона 4, Маргарита 9')
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

  it('omits the urgent block when there is nothing urgent', () => {
    const msg = formatQualityReport({ report: REPORT, urgent: [] })
    expect(msg).not.toContain('ОЧЕНЬ СРОЧНО')
  })

  it('lists accountants with flag emojis', () => {
    const msg = formatQualityReport({ report: REPORT })
    expect(msg).toContain('Анна: 🔴1 ⚠️3 👍2')
    expect(msg).toContain('Борис: ⚠️2 👍5')
  })

  it('escapes accountant / client names', () => {
    const msg = formatQualityReport({
      report: { department: {}, byAccountant: [{ accountantName: 'A & B <x>', issues: 1, praise: 0, urgent: 0 }] },
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
