// Compare accountant feedback (tasks «задачи» and comments/words «слова») against
// the REAL work recorded in the OB Artyom project — ArmSoft + TaxService.
//
// Owner ask: «for every person's word and every person's zadacha in the
// accountant feedback form there is sravnenie with the database about taxservice
// and armsoft». A task or a comment is a CLAIM about work; this module answers
// "does the ArmSoft / TaxService database actually back it up?" and also rolls a
// whole day up into one department analysis for the daily chat message.
//
// Pure & DB-free so it can be unit-tested and reused identically by the in-app
// panels (DbComparison / DailyAnalysis) and the Telegram edge function — the
// same numbers the chat gets are the ones shown here. The fetching lives in
// api.js (Artyom REST via artyomClient); this module owns only the logic/wording.
//
// Data shapes (proven by src/pages/Accounting.jsx against the Artyom project):
//   company  (ob_accounting_companies): { company_name, contract_number,
//              accountant_name, is_active, armsoft_company_id, tax_account_id }
//   activity (accounting_activities):    { company_name, accountant_name,
//              activity_date, system_source ∈ 'base'|'armsoft'|'taxservice',
//              invoices_issued, reports_submitted, applications_filed,
//              balance_changes }

// ─── name / contract normalisation ──────────────────────────────────────────

/** Case/space-insensitive company-name key. */
export function normName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Normalise a contract number so Cyrillic and Latin prefixes compare equal
 * (mirror of mainClient.normalizeContractNo, kept local so this module stays
 * dependency-free/testable). В-3142 === B-3142, Н-100 === N-100.
 */
export function normalizeContract(raw) {
  return String(raw ?? '')
    .replace(/№\s*/g, '')
    .replace(/В/g, 'B')
    .replace(/Н/g, 'N')
    .replace(/б/g, 'b')
    .trim()
    .toUpperCase()
}

// ─── totals helpers ───────────────────────────────────────────────────────────

export const METRICS = ['invoices', 'reports', 'applications', 'balance']

export const METRIC_LABELS = {
  invoices: 'Инвойсы',
  reports: 'Отчёты',
  applications: 'Заявления',
  balance: 'Остатки',
}

export function emptyTotals() {
  return { invoices: 0, reports: 0, applications: 0, balance: 0 }
}

function addActivityInto(totals, a) {
  totals.invoices += Number(a.invoices_issued ?? 0)
  totals.reports += Number(a.reports_submitted ?? 0)
  totals.applications += Number(a.applications_filed ?? 0)
  totals.balance += Number(a.balance_changes ?? 0)
  return totals
}

export function totalsSum(t) {
  return (t.invoices ?? 0) + (t.reports ?? 0) + (t.applications ?? 0) + (t.balance ?? 0)
}

/** taxservice − armsoft per metric; a non-zero value is a reconciliation gap. */
export function diffTotals(taxservice, armsoft) {
  return {
    invoices: (taxservice.invoices ?? 0) - (armsoft.invoices ?? 0),
    reports: (taxservice.reports ?? 0) - (armsoft.reports ?? 0),
    applications: (taxservice.applications ?? 0) - (armsoft.applications ?? 0),
    balance: (taxservice.balance ?? 0) - (armsoft.balance ?? 0),
  }
}

export function hasDiscrepancy(diff) {
  return METRICS.some((m) => (diff[m] ?? 0) !== 0)
}

// ─── company matching ──────────────────────────────────────────────────────────

/**
 * Best matching company for a task/comment. Deterministic, no fuzzy merge
 * (per the app rule: similar-but-unequal names are NOT auto-merged):
 *   1. exact normalised contract number (handles Cyrillic/Latin),
 *   2. else exact normalised company name.
 * Returns the company row or null.
 */
export function matchCompany(companies, { clientName, contractNo } = {}) {
  const list = companies || []
  const wantContract = contractNo ? normalizeContract(contractNo) : null
  if (wantContract) {
    const byContract = list.find(
      (c) => c.contract_number && normalizeContract(c.contract_number) === wantContract,
    )
    if (byContract) return byContract
  }
  const wantName = clientName ? normName(clientName) : null
  if (wantName) {
    const byName = list.find((c) => normName(c.company_name) === wantName)
    if (byName) return byName
  }
  return null
}

// ─── per-entity comparison ─────────────────────────────────────────────────────

// Which metric a task type is really "about", so the verdict can point at it.
export const TASK_METRIC = {
  report: 'reports',
  receipt: 'invoices',
  mailing: 'invoices',
  audit: 'balance',
}

/**
 * Compare one task/comment against the DB. `activities` should already be scoped
 * to the comparison window (e.g. last 30 days). We narrow to the matched company
 * (by name) and split ArmSoft vs TaxService.
 *
 * ctx: { clientName, contractNo, accountantName, taskType }
 * → {
 *     matched, company, inArmsoft, inTaxservice,
 *     armsoft, taxservice, base, total, diff, hasDiscrepancy, hasWork,
 *     relevantMetric, verdict: { key, label, tone }
 *   }
 * tone ∈ 'ok' | 'warn' | 'alert' | 'muted'
 */
export function buildComparison({ companies, activities, ...ctx } = {}) {
  const company = matchCompany(companies, ctx)
  const armsoft = emptyTotals()
  const taxservice = emptyTotals()
  const base = emptyTotals()

  if (company) {
    const key = normName(company.company_name)
    for (const a of activities || []) {
      if (normName(a.company_name) !== key) continue
      if (a.system_source === 'armsoft') addActivityInto(armsoft, a)
      else if (a.system_source === 'taxservice') addActivityInto(taxservice, a)
      else addActivityInto(base, a)
    }
  }

  const total = {
    invoices: armsoft.invoices + taxservice.invoices + base.invoices,
    reports: armsoft.reports + taxservice.reports + base.reports,
    applications: armsoft.applications + taxservice.applications + base.applications,
    balance: armsoft.balance + taxservice.balance + base.balance,
  }
  const diff = diffTotals(taxservice, armsoft)
  const discrepancy = hasDiscrepancy(diff)
  const hasWork = totalsSum(total) > 0
  const inArmsoft = !!(company && company.armsoft_company_id)
  const inTaxservice = !!(company && company.tax_account_id)
  const relevantMetric = TASK_METRIC[ctx.taskType] || null

  let verdict
  if (!company) {
    verdict = {
      key: 'unmatched',
      label: 'Клиент не найден в базе ArmSoft/TaxService',
      tone: 'warn',
    }
  } else if (!inArmsoft && !inTaxservice) {
    verdict = {
      key: 'no_systems',
      label: 'Клиент есть, но не привязан к ArmSoft/TaxService',
      tone: 'warn',
    }
  } else if (!hasWork) {
    verdict = {
      key: 'no_work',
      label: 'Нет операций в базе за период',
      tone: 'alert',
    }
  } else if (discrepancy) {
    verdict = {
      key: 'discrepancy',
      label: 'Расхождение ТаксСервис ↔ АрмСофт',
      tone: 'alert',
    }
  } else {
    verdict = { key: 'ok', label: 'Подтверждено базой', tone: 'ok' }
  }

  return {
    matched: !!company,
    company: company || null,
    inArmsoft,
    inTaxservice,
    armsoft,
    taxservice,
    base,
    total,
    diff,
    hasDiscrepancy: discrepancy,
    hasWork,
    relevantMetric,
    verdict,
  }
}

// ─── daily department analysis (for the chat + the in-app panel) ────────────────

/**
 * Roll a single day's activities up into a department analysis: per-accountant
 * ArmSoft/TaxService totals, department totals, reconciliation gaps and the
 * day's comments. `activities` are expected to be that day's rows (any source);
 * `comments` are accountant_daily_comments rows for the day (optional).
 *
 * → {
 *     date, department: { armsoft, taxservice, base, total, diff, hasDiscrepancy,
 *                         accountants, companies, actions },
 *     byAccountant: [{ accountant, armsoft, taxservice, base, total, diff,
 *                      hasDiscrepancy, companies, comments }],
 *     discrepancies: [ …byAccountant rows with a gap ],
 *     comments,
 *   }
 */
export function buildDailyAnalysis(activities, { date = null, comments = [] } = {}) {
  const byAcc = new Map()
  const companiesByAcc = new Map()
  const deptArm = emptyTotals()
  const deptTax = emptyTotals()
  const deptBase = emptyTotals()
  const companiesAll = new Set()

  for (const a of activities || []) {
    const acc = a.accountant_name || '— без бухгалтера'
    if (!byAcc.has(acc)) {
      byAcc.set(acc, { armsoft: emptyTotals(), taxservice: emptyTotals(), base: emptyTotals() })
      companiesByAcc.set(acc, new Set())
    }
    const bucket = byAcc.get(acc)
    if (a.company_name) {
      companiesByAcc.get(acc).add(normName(a.company_name))
      companiesAll.add(normName(a.company_name))
    }
    if (a.system_source === 'armsoft') {
      addActivityInto(bucket.armsoft, a)
      addActivityInto(deptArm, a)
    } else if (a.system_source === 'taxservice') {
      addActivityInto(bucket.taxservice, a)
      addActivityInto(deptTax, a)
    } else {
      addActivityInto(bucket.base, a)
      addActivityInto(deptBase, a)
    }
  }

  const commentsByAcc = new Map()
  for (const c of comments || []) {
    const acc = c.accountant_name || '— без бухгалтера'
    if (!commentsByAcc.has(acc)) commentsByAcc.set(acc, [])
    commentsByAcc.get(acc).push(c)
  }

  const byAccountant = [...byAcc.entries()]
    .map(([accountant, b]) => {
      const total = {
        invoices: b.armsoft.invoices + b.taxservice.invoices + b.base.invoices,
        reports: b.armsoft.reports + b.taxservice.reports + b.base.reports,
        applications: b.armsoft.applications + b.taxservice.applications + b.base.applications,
        balance: b.armsoft.balance + b.taxservice.balance + b.base.balance,
      }
      const diff = diffTotals(b.taxservice, b.armsoft)
      return {
        accountant,
        armsoft: b.armsoft,
        taxservice: b.taxservice,
        base: b.base,
        total,
        diff,
        hasDiscrepancy: hasDiscrepancy(diff),
        companies: companiesByAcc.get(accountant)?.size || 0,
        comments: commentsByAcc.get(accountant) || [],
      }
    })
    .sort((a, b) => totalsSum(b.total) - totalsSum(a.total) || a.accountant.localeCompare(b.accountant, 'ru'))

  const deptTotal = {
    invoices: deptArm.invoices + deptTax.invoices + deptBase.invoices,
    reports: deptArm.reports + deptTax.reports + deptBase.reports,
    applications: deptArm.applications + deptTax.applications + deptBase.applications,
    balance: deptArm.balance + deptTax.balance + deptBase.balance,
  }
  const deptDiff = diffTotals(deptTax, deptArm)

  return {
    date,
    department: {
      armsoft: deptArm,
      taxservice: deptTax,
      base: deptBase,
      total: deptTotal,
      diff: deptDiff,
      hasDiscrepancy: hasDiscrepancy(deptDiff),
      accountants: byAccountant.length,
      companies: companiesAll.size,
      actions: totalsSum(deptTotal),
    },
    byAccountant,
    discrepancies: byAccountant.filter((r) => r.hasDiscrepancy),
    comments: comments || [],
  }
}

// ─── Telegram wording (mirrors buildDailyAnalysis; kept plain-text) ─────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ')
}

function fmtDateHuman(d) {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${day}.${m}.${y}`
}

function totalsLine(t) {
  return METRICS.filter((m) => (t[m] ?? 0) > 0)
    .map((m) => `${METRIC_LABELS[m]}: ${fmtNum(t[m])}`)
    .join(' · ') || '—'
}

/**
 * Telegram HTML message for the daily analysis. Same content as the in-app
 * DailyAnalysis panel so «sent in the chat» === «seen here».
 */
export function formatDailyAnalysisText(analysis, { limitAccountants = 20 } = {}) {
  const a = analysis || buildDailyAnalysis([])
  const d = a.department
  const lines = []
  lines.push(`📊 <b>Дневной анализ базы (ArmSoft + TaxService)</b>`)
  lines.push(`За день: <b>${esc(fmtDateHuman(a.date))}</b>`)
  lines.push('')
  lines.push(
    `Бухгалтеров с работой: <b>${d.accountants}</b> · компаний: <b>${d.companies}</b> · действий: <b>${fmtNum(d.actions)}</b>`,
  )
  lines.push(`АрмСофт — ${totalsLine(d.armsoft)}`)
  lines.push(`ТаксСервис — ${totalsLine(d.taxservice)}`)
  if (d.hasDiscrepancy) {
    const gaps = METRICS.filter((m) => (d.diff[m] ?? 0) !== 0)
      .map((m) => `${METRIC_LABELS[m]} ${d.diff[m] > 0 ? '+' : ''}${d.diff[m]}`)
      .join(', ')
    lines.push(`⚠️ Расхождение ТаксСервис−АрмСофт: ${esc(gaps)}`)
  }

  if (a.byAccountant.length) {
    lines.push('')
    lines.push('<b>По бухгалтерам:</b>')
    for (const r of a.byAccountant.slice(0, limitAccountants)) {
      const flag = r.hasDiscrepancy ? ' ⚠️' : ''
      lines.push(
        `• ${esc(r.accountant)}${flag} — действий ${fmtNum(totalsSum(r.total))} ` +
          `(АС ${fmtNum(totalsSum(r.armsoft))} / ТС ${fmtNum(totalsSum(r.taxservice))}), компаний ${r.companies}`,
      )
    }
    if (a.byAccountant.length > limitAccountants) {
      lines.push(`… и ещё ${a.byAccountant.length - limitAccountants}`)
    }
  } else {
    lines.push('')
    lines.push('За этот день в базе нет операций.')
  }

  return lines.join('\n')
}
