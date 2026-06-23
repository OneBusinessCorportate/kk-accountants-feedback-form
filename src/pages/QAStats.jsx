import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchAccuracyStats } from '../lib/api'
import { SOURCE_LABELS } from '../lib/constants'
import { Loading, ErrorMessage, Empty } from '../components/States'

const AI_SUBTYPE_LABELS = {
  unanswered: 'Без ответа',
  late: 'Поздний ответ',
  promise: 'Невыполн. обещание',
  review: 'Без ответа (неопред.)',
}

function accuracyColor(pct) {
  if (pct === null) return undefined
  if (pct >= 80) return 'var(--green)'
  if (pct >= 60) return 'var(--amber)'
  return 'var(--red)'
}

function AccuracyBadge({ pct }) {
  if (pct === null) return <span className="badge badge-gray">—</span>
  const cls = pct >= 80 ? 'badge-green' : pct >= 60 ? 'badge-amber' : 'badge-red'
  return <span className={`badge ${cls}`}>{pct.toFixed(1)}%</span>
}

function BreakdownTable({ rows, labelFn, title }) {
  if (!rows.length) return null
  return (
    <>
      <div className="section-label" style={{ marginTop: 28 }}>
        {title}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Источник</th>
              <th>Оценено</th>
              <th>Верно</th>
              <th>Ложных</th>
              <th>Точность</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source ?? r.prefix}>
                <td>{labelFn(r)}</td>
                <td>{r.total}</td>
                <td style={{ color: 'var(--green)', fontWeight: 600 }}>{r.correct}</td>
                <td style={{ color: 'var(--red)', fontWeight: 600 }}>{r.incorrect}</td>
                <td>
                  <AccuracyBadge pct={r.accuracy} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export default function QAStats() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  function load() {
    setLoading(true)
    setError(null)
    fetchAccuracyStats()
      .then(setStats)
      .catch(setError)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const overall = stats?.overall
  const pct = overall?.accuracy

  const statCards = overall
    ? [
        { label: 'Оценено проблем', num: overall.total, color: undefined },
        { label: 'Верно обнаружено', num: overall.correct, color: 'var(--green)' },
        { label: 'Ложных срабатываний', num: overall.incorrect, color: 'var(--red)' },
        { label: 'Точность', num: pct !== null ? `${pct.toFixed(1)}%` : '—', color: accuracyColor(pct) },
      ]
    : []

  return (
    <div>
      <h1 className="page-title">QA Точность</h1>
      <p className="page-subtitle">
        Доля верно обнаруженных проблем по оценкам проверяющих — «Действительно проблема» vs
        «Ложное срабатывание».
      </p>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : !overall || overall.total === 0 ? (
        <Empty text="Нет оценённых проблем. Расставьте оценки на странице Проверка." />
      ) : (
        <>
          <div className="stat-grid">
            {statCards.map((s) => (
              <div key={s.label} className="stat">
                <div className="num" style={s.color ? { color: s.color } : undefined}>
                  {s.num}
                </div>
                <div className="label">{s.label}</div>
              </div>
            ))}
          </div>

          <BreakdownTable
            rows={stats.perSource}
            labelFn={(r) => SOURCE_LABELS[r.source] || r.source}
            title="По источнику обнаружения"
          />

          {stats.aiSubtypes.length > 0 && (
            <BreakdownTable
              rows={stats.aiSubtypes}
              labelFn={(r) => AI_SUBTYPE_LABELS[r.prefix] || r.prefix}
              title="AI — по типу нарушения"
            />
          )}

          <p className="hint" style={{ marginTop: 20 }}>
            Точность = верно обнаружено ÷ всего оценено. Оценки расставляются на странице{' '}
            <Link to="/review">Проверка</Link> (кнопки «Действительно проблема» / «Ложное
            срабатывание»).
          </p>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={load}>
              Обновить
            </button>
          </div>
        </>
      )}
    </div>
  )
}
