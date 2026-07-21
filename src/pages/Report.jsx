import { useEffect, useState } from 'react'
import { fetchLatestPublishedReport } from '../lib/api'
import { Loading, ErrorMessage } from '../components/States'

function fmtDateTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Asia/Yerevan',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * «Отчёт» — the daily accounting report AFTER Margarita reviewed / edited /
 * approved it on the QA platform. Replaces the retired PDF: accountants read the
 * approved text here (read-only), fetched from the kk_published_reports view.
 */
export default function Report() {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetchLatestPublishedReport()
      .then((r) => {
        if (alive) setReport(r)
      })
      .catch((e) => {
        if (alive) setError(e)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  if (loading) return <Loading />
  if (error) return <ErrorMessage error={error} />

  return (
    <div>
      <h1 className="page-title" style={{ margin: 0 }}>
        {report?.title || 'Отчёт бухгалтерии'}
      </h1>
      <p className="page-subtitle">
        Отчёт, подготовленный и утверждённый QA (Маргарита). Показана последняя
        опубликованная версия.
      </p>

      {!report ? (
        <div className="card" style={{ padding: '1.5rem', color: 'var(--muted)' }}>
          Отчёт ещё не опубликован. Он появится здесь, как только QA утвердит
          ежедневный отчёт.
        </div>
      ) : (
        <div className="card" style={{ padding: '1.25rem' }}>
          <div style={{ marginBottom: '0.75rem', fontSize: 12, color: 'var(--muted)' }}>
            {report.period_label ? <>Период: {report.period_label} · </> : null}
            Опубликовано: {fmtDateTime(report.published_at)}
            {report.published_by ? <> · {report.published_by}</> : null}
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: '0.95rem',
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            {report.body}
          </pre>
        </div>
      )}
    </div>
  )
}
