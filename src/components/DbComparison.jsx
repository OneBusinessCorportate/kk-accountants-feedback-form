import { useMemo, useState } from 'react'
import {
  buildComparison,
  METRICS,
  METRIC_LABELS,
  totalsSum,
} from '../lib/artyomCompare'

const TONE_BADGE = {
  ok: 'badge-green',
  warn: 'badge-amber',
  alert: 'badge-red',
  muted: 'badge-gray',
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ')
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${day}.${m}.${y}`
}

function TotalsRow({ label, totals, highlight }) {
  const cells = METRICS.filter((k) => (totals[k] ?? 0) !== 0)
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.82em', margin: '1px 0' }}>
      <span style={{ minWidth: 78, color: 'var(--muted)' }}>{label}</span>
      {cells.length ? (
        cells.map((k) => (
          <span key={k} style={highlight ? { color: '#b42318', fontWeight: 600 } : undefined}>
            {METRIC_LABELS[k]}: <b>{highlight && totals[k] > 0 ? '+' : ''}{fmt(totals[k])}</b>
          </span>
        ))
      ) : (
        <span style={{ color: 'var(--muted)' }}>—</span>
      )}
    </div>
  )
}

/**
 * «Сравнение с базой (ArmSoft / TaxService)» for a single task or comment/word.
 * Collapsed by default (show/hide) so cards stay compact; the verdict badge is
 * always visible. Computes locally from the page-level Artyom data.
 *
 * props: { companies, activities, from, to, ready, loading,
 *          clientName, contractNo, accountantName, taskType }
 */
export default function DbComparison({
  companies = [],
  activities = [],
  from,
  to,
  ready = true,
  loading = false,
  clientName,
  contractNo,
  accountantName,
  taskType,
}) {
  const [open, setOpen] = useState(false)

  const cmp = useMemo(
    () =>
      buildComparison({ companies, activities, clientName, contractNo, accountantName, taskType }),
    [companies, activities, clientName, contractNo, accountantName, taskType],
  )

  if (!ready) {
    return (
      <div className="dbcmp">
        <span className="badge badge-gray">База не настроена</span>
      </div>
    )
  }

  const badgeClass = TONE_BADGE[cmp.verdict.tone] || 'badge-gray'
  const armTotal = totalsSum(cmp.armsoft)
  const taxTotal = totalsSum(cmp.taxservice)

  return (
    <div className="dbcmp">
      <button
        type="button"
        className="dbcmp-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="dbcmp-caret">{open ? '▾' : '▸'}</span>
        <span className="dbcmp-title">Сравнение с базой</span>
        {loading ? (
          <span className="badge badge-gray">Загрузка…</span>
        ) : (
          <span className={`badge ${badgeClass}`}>{cmp.verdict.label}</span>
        )}
        {!loading && cmp.matched && (
          <span className="dbcmp-quick">
            АС {fmt(armTotal)} · ТС {fmt(taxTotal)}
          </span>
        )}
      </button>

      {open && !loading && (
        <div className="dbcmp-body">
          {cmp.company ? (
            <div style={{ fontSize: '0.82em', color: 'var(--muted)', marginBottom: 4 }}>
              {cmp.company.company_name}
              {cmp.company.contract_number ? ` · ${cmp.company.contract_number}` : ''}
              {cmp.company.accountant_name ? ` · ${cmp.company.accountant_name}` : ''}
              {' · '}
              {cmp.inArmsoft ? 'ArmSoft ✓' : 'ArmSoft —'}
              {' / '}
              {cmp.inTaxservice ? 'TaxService ✓' : 'TaxService —'}
            </div>
          ) : (
            <div style={{ fontSize: '0.82em', color: 'var(--muted)', marginBottom: 4 }}>
              {clientName ? `«${clientName}»` : 'Клиент'} не найден в реестре ArmSoft/TaxService.
            </div>
          )}

          {cmp.matched && (
            <>
              <TotalsRow label="АрмСофт" totals={cmp.armsoft} />
              <TotalsRow label="ТаксСервис" totals={cmp.taxservice} />
              {cmp.hasDiscrepancy && (
                <TotalsRow label="Расхождение" totals={cmp.diff} highlight />
              )}
              {cmp.relevantMetric && (
                <div style={{ fontSize: '0.78em', color: 'var(--muted)', marginTop: 4 }}>
                  По задаче важен показатель «{METRIC_LABELS[cmp.relevantMetric]}»: АрмСофт{' '}
                  <b>{fmt(cmp.armsoft[cmp.relevantMetric])}</b> · ТаксСервис{' '}
                  <b>{fmt(cmp.taxservice[cmp.relevantMetric])}</b>
                </div>
              )}
            </>
          )}

          <div style={{ fontSize: '0.74em', color: 'var(--muted)', marginTop: 4 }}>
            Период сверки: {fmtDate(from)} – {fmtDate(to)}
          </div>
        </div>
      )}
    </div>
  )
}
