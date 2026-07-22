import { useEffect, useMemo, useState } from 'react'
import { fetchArtyomActivities, fetchArtyomComments } from '../lib/api'
import { artyomConfigError } from '../lib/artyomClient'
import {
  buildDailyAnalysis,
  METRICS,
  METRIC_LABELS,
  totalsSum,
} from '../lib/artyomCompare'

function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Yerevan' })
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${day}.${m}.${y}`
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ')
}

function totalsText(t) {
  const parts = METRICS.filter((k) => (t[k] ?? 0) > 0).map((k) => `${METRIC_LABELS[k]}: ${fmt(t[k])}`)
  return parts.length ? parts.join(' · ') : '—'
}

/**
 * Full daily analysis from Supabase (ArmSoft + TaxService), collapsible so it
 * can be shown or hidden. This is the SAME analysis the Telegram chat receives
 * (both use buildDailyAnalysis) — «sent in the chat» === «seen here».
 *
 * Fetches its own day (default: today, Yerevan) so it can live on any page.
 */
export default function DailyAnalysis({ defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [date, setDate] = useState(localToday())
  const [rows, setRows] = useState([])
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [loadedFor, setLoadedFor] = useState(null)

  // Only fetch once the panel is opened (and refetch when the day changes).
  useEffect(() => {
    if (!open || artyomConfigError) return
    if (loadedFor === date) return
    let alive = true
    setLoading(true)
    setError(null)
    Promise.all([
      fetchArtyomActivities({ from: date, to: date }),
      fetchArtyomComments({ from: date, to: date }),
    ])
      .then(([a, c]) => {
        if (!alive) return
        setRows(a)
        setComments(c)
        setLoadedFor(date)
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, date, loadedFor])

  const analysis = useMemo(
    () => buildDailyAnalysis(rows, { date, comments }),
    [rows, date, comments],
  )
  const dep = analysis.department

  const configured = !artyomConfigError

  return (
    <div className="daily-analysis">
      <div className="daily-analysis-head">
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Скрыть анализ базы ▾' : 'Показать анализ базы ▸'}
        </button>
        <span className="daily-analysis-caption">
          Дневной анализ (ArmSoft + TaxService) — то же, что уходит в чат
        </span>
        {open && (
          <input
            type="date"
            className="daily-analysis-date"
            value={date}
            max={localToday()}
            onChange={(e) => setDate(e.target.value)}
          />
        )}
      </div>

      {open && (
        <div className="daily-analysis-body">
          {!configured ? (
            <p className="hint">
              База ArmSoft/TaxService не настроена (VITE_ARTYOM_SUPABASE_URL /
              VITE_ARTYOM_SUPABASE_ANON_KEY).
            </p>
          ) : loading ? (
            <p className="hint">Загрузка анализа за {fmtDate(date)}…</p>
          ) : error ? (
            <p className="hint" style={{ color: '#b42318' }}>
              Ошибка: {error.message}
            </p>
          ) : dep.actions === 0 ? (
            <p className="hint">За {fmtDate(date)} в базе нет операций.</p>
          ) : (
            <>
              <div className="daily-analysis-summary">
                <span>
                  Бухгалтеров: <b>{dep.accountants}</b>
                </span>
                <span>
                  Компаний: <b>{dep.companies}</b>
                </span>
                <span>
                  Действий: <b>{fmt(dep.actions)}</b>
                </span>
              </div>
              <div style={{ fontSize: '0.85em', margin: '2px 0' }}>
                АрмСофт — {totalsText(dep.armsoft)}
              </div>
              <div style={{ fontSize: '0.85em', margin: '2px 0' }}>
                ТаксСервис — {totalsText(dep.taxservice)}
              </div>
              {dep.hasDiscrepancy && (
                <div style={{ fontSize: '0.85em', color: '#b42318', margin: '2px 0' }}>
                  ⚠️ Есть расхождения ТаксСервис ↔ АрмСофт
                </div>
              )}

              <table className="daily-analysis-table">
                <thead>
                  <tr>
                    <th>Бухгалтер</th>
                    <th>Действий</th>
                    <th>АС</th>
                    <th>ТС</th>
                    <th>Комп.</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.byAccountant.map((r) => (
                    <tr key={r.accountant}>
                      <td>{r.accountant}</td>
                      <td>{fmt(totalsSum(r.total))}</td>
                      <td>{fmt(totalsSum(r.armsoft))}</td>
                      <td>{fmt(totalsSum(r.taxservice))}</td>
                      <td>{r.companies}</td>
                      <td>{r.hasDiscrepancy ? <span className="badge badge-red">⚠️</span> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
