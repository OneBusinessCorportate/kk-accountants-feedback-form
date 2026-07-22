import { describe, it, expect } from 'vitest'
import {
  normName,
  normalizeContract,
  matchCompany,
  buildComparison,
  buildDailyAnalysis,
  formatDailyAnalysisText,
  diffTotals,
  hasDiscrepancy,
  totalsSum,
} from './artyomCompare'

const companies = [
  {
    company_name: 'Рога и Копыта ООО',
    contract_number: 'B-3142',
    accountant_name: 'Olya Accounting',
    is_active: true,
    armsoft_company_id: 11,
    tax_account_id: 21,
  },
  {
    company_name: 'Bright Future LLC',
    contract_number: 'N-100',
    accountant_name: 'Naira Mkhitaryan',
    is_active: true,
    armsoft_company_id: null,
    tax_account_id: null,
  },
]

function act(over) {
  return {
    company_name: 'Рога и Копыта ООО',
    accountant_name: 'Olya Accounting',
    activity_date: '2026-07-20',
    system_source: 'armsoft',
    invoices_issued: 0,
    reports_submitted: 0,
    applications_filed: 0,
    balance_changes: 0,
    ...over,
  }
}

describe('normalisation', () => {
  it('collapses case and spaces in names', () => {
    expect(normName('  Рога   и Копыта ООО ')).toBe('рога и копыта ооо')
  })
  it('makes Cyrillic and Latin contract prefixes equal', () => {
    expect(normalizeContract('В-3142')).toBe(normalizeContract('B-3142'))
    expect(normalizeContract('№ Н-100')).toBe('N-100') // Cyrillic Н → Latin N
  })
})

describe('matchCompany', () => {
  it('matches by contract number across alphabets', () => {
    const m = matchCompany(companies, { contractNo: 'В-3142' }) // Cyrillic В
    expect(m?.company_name).toBe('Рога и Копыта ООО')
  })
  it('matches by exact normalised name when no contract', () => {
    const m = matchCompany(companies, { clientName: 'bright future llc' })
    expect(m?.contract_number).toBe('N-100')
  })
  it('does NOT fuzzy-match similar-but-unequal names', () => {
    expect(matchCompany(companies, { clientName: 'Bright Future' })).toBeNull()
  })
  it('returns null when nothing matches', () => {
    expect(matchCompany(companies, { clientName: 'Unknown Co' })).toBeNull()
  })
})

describe('buildComparison verdicts', () => {
  it('flags unmatched clients', () => {
    const c = buildComparison({ companies, activities: [], clientName: 'Nope' })
    expect(c.matched).toBe(false)
    expect(c.verdict.key).toBe('unmatched')
    expect(c.verdict.tone).toBe('warn')
  })

  it('flags a matched client with no system binding', () => {
    const c = buildComparison({ companies, activities: [], contractNo: 'N-100' })
    expect(c.matched).toBe(true)
    expect(c.inArmsoft).toBe(false)
    expect(c.inTaxservice).toBe(false)
    expect(c.verdict.key).toBe('no_systems')
  })

  it('flags no work in the window', () => {
    const c = buildComparison({ companies, activities: [], contractNo: 'B-3142' })
    expect(c.verdict.key).toBe('no_work')
    expect(c.verdict.tone).toBe('alert')
  })

  it('confirms work when ArmSoft and TaxService agree', () => {
    const activities = [
      act({ system_source: 'armsoft', reports_submitted: 3 }),
      act({ system_source: 'taxservice', reports_submitted: 3 }),
    ]
    const c = buildComparison({ companies, activities, contractNo: 'B-3142', taskType: 'report' })
    expect(c.verdict.key).toBe('ok')
    expect(c.relevantMetric).toBe('reports')
    expect(c.armsoft.reports).toBe(3)
    expect(c.taxservice.reports).toBe(3)
    expect(c.hasDiscrepancy).toBe(false)
  })

  it('detects a reconciliation gap between TaxService and ArmSoft', () => {
    const activities = [
      act({ system_source: 'armsoft', reports_submitted: 3 }),
      act({ system_source: 'taxservice', reports_submitted: 5 }),
    ]
    const c = buildComparison({ companies, activities, contractNo: 'B-3142' })
    expect(c.verdict.key).toBe('discrepancy')
    expect(c.diff.reports).toBe(2)
    expect(c.hasDiscrepancy).toBe(true)
  })

  it('ignores activity from other companies', () => {
    const activities = [
      act({ company_name: 'Other Co', system_source: 'armsoft', invoices_issued: 9 }),
    ]
    const c = buildComparison({ companies, activities, contractNo: 'B-3142' })
    expect(totalsSum(c.total)).toBe(0)
    expect(c.verdict.key).toBe('no_work')
  })
})

describe('diff helpers', () => {
  it('computes taxservice minus armsoft', () => {
    const d = diffTotals({ invoices: 5 }, { invoices: 2 })
    expect(d.invoices).toBe(3)
    expect(hasDiscrepancy(d)).toBe(true)
    expect(hasDiscrepancy(diffTotals({ invoices: 2 }, { invoices: 2 }))).toBe(false)
  })
})

describe('buildDailyAnalysis', () => {
  const activities = [
    act({ accountant_name: 'Olya Accounting', system_source: 'armsoft', invoices_issued: 4 }),
    act({ accountant_name: 'Olya Accounting', system_source: 'taxservice', invoices_issued: 4 }),
    act({
      accountant_name: 'Naira Mkhitaryan',
      company_name: 'Bright Future LLC',
      system_source: 'armsoft',
      reports_submitted: 2,
    }),
    act({
      accountant_name: 'Naira Mkhitaryan',
      company_name: 'Bright Future LLC',
      system_source: 'taxservice',
      reports_submitted: 5, // gap: tax 5 vs armsoft 2
    }),
  ]

  it('aggregates department + per-accountant totals', () => {
    const a = buildDailyAnalysis(activities, { date: '2026-07-20' })
    expect(a.department.accountants).toBe(2)
    expect(a.department.companies).toBe(2)
    expect(a.department.armsoft.invoices).toBe(4)
    expect(a.department.taxservice.invoices).toBe(4)
    // sorted by total work desc — Olya (8 invoices) before Naira (7 reports)
    expect(a.byAccountant[0].accountant).toBe('Olya Accounting')
  })

  it('surfaces per-accountant discrepancies', () => {
    const a = buildDailyAnalysis(activities, { date: '2026-07-20' })
    expect(a.discrepancies.map((r) => r.accountant)).toContain('Naira Mkhitaryan')
    const naira = a.byAccountant.find((r) => r.accountant === 'Naira Mkhitaryan')
    expect(naira.diff.reports).toBe(3)
  })

  it('attaches the day comments to the right accountant', () => {
    const a = buildDailyAnalysis(activities, {
      date: '2026-07-20',
      comments: [{ accountant_name: 'Olya Accounting', comment: 'консультация' }],
    })
    const olya = a.byAccountant.find((r) => r.accountant === 'Olya Accounting')
    expect(olya.comments).toHaveLength(1)
  })

  it('handles an empty day', () => {
    const a = buildDailyAnalysis([], { date: '2026-07-20' })
    expect(a.department.actions).toBe(0)
    expect(a.byAccountant).toHaveLength(0)
  })
})

describe('formatDailyAnalysisText', () => {
  it('produces a chat message with totals and per-accountant lines', () => {
    const a = buildDailyAnalysis(
      [
        act({ accountant_name: 'Olya Accounting', system_source: 'armsoft', invoices_issued: 4 }),
        act({ accountant_name: 'Olya Accounting', system_source: 'taxservice', invoices_issued: 6 }),
      ],
      { date: '2026-07-20' },
    )
    const txt = formatDailyAnalysisText(a)
    expect(txt).toContain('Дневной анализ базы')
    expect(txt).toContain('20.07.2026')
    expect(txt).toContain('Olya Accounting')
    expect(txt).toContain('⚠️') // invoices 6 vs 4 → gap surfaced
  })

  it('says so when the day is empty', () => {
    const txt = formatDailyAnalysisText(buildDailyAnalysis([], { date: '2026-07-20' }))
    expect(txt).toContain('нет операций')
  })

  it('escapes HTML in names', () => {
    const a = buildDailyAnalysis([act({ accountant_name: '<b>x</b>', invoices_issued: 1 })], {
      date: '2026-07-20',
    })
    expect(formatDailyAnalysisText(a)).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
