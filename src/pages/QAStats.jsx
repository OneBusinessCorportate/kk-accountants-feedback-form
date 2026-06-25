import { useEffect, useRef, useState } from 'react'
import { fetchProblems, rateProblem } from '../lib/api'
import { SOURCE_LABELS, VERDICT_LABELS } from '../lib/constants'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage, Empty } from '../components/States'

const AI_SUBTYPE_LABELS = {
  unanswered: 'Без ответа',
  late: 'Поздний ответ',
  promise: 'Невыполн. обещание',
  review: 'Без ответа (неопред.)',
}

function aiSubtype(problemId) {
  const prefix = problemId.split(':')[0]
  return AI_SUBTYPE_LABELS[prefix] || null
}

const FILTER_KEYS = ['all', 'unrated', 'problematic', 'not_problematic']

function matchFilter(p, key) {
  if (key === 'all') return true
  if (key === 'unrated') return !p.verdict
  return p.verdict === key
}

function ProblemCard({ problem, onChanged }) {
  const { access } = useAuth()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function rate(isProblematic) {
    setBusy(true)
    setErr(null)
    try {
      await rateProblem({
        problemId: problem.problem_id,
        isProblematic,
        comment: comment.trim(),
        ratedBy: access?.full_name || null,
        problemDetectedAt: problem.detected_at || null,
      })
      setComment('')
      onChanged()
    } catch (e) {
      setErr(e)
    } finally {
      setBusy(false)
    }
  }

  const v = problem.verdict
  const src = SOURCE_LABELS[problem.source] || problem.source
  const sub = problem.source === 'ai' ? aiSubtype(problem.problem_id) : null

  return (
    <div className="card">
      <div className="card-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
          <h3 className="card-title">{problem.problem_title || problem.problem_id}</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge badge-blue">
              {src}
              {sub ? ` · ${sub}` : ''}
            </span>
            {problem.accountant_name && (
              <span className="badge badge-gray">Бухгалтер: {problem.accountant_name}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          {v ? (
            <span className={`badge ${v === 'problematic' ? 'badge-green' : 'badge-red'}`}>
              {VERDICT_LABELS[v]}
            </span>
          ) : (
            <span className="badge badge-gray">Не оценено</span>
          )}
          {problem.detected_at && (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {new Date(problem.detected_at).toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'short',
              })}
            </span>
          )}
        </div>
      </div>

      {problem.client_name && (
        <div className="meta">
          <span>
            Клиент: <b>{problem.client_name}</b>
          </span>
          {problem.chat_link && (
            <a href={problem.chat_link} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
              → Открыть чат
            </a>
          )}
        </div>
      )}

      {problem.problem_description && (
        <div className="description">{problem.problem_description}</div>
      )}

      {problem.ai_comment && (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          ИИ: {problem.ai_comment}
        </p>
      )}

      {err && <div className="alert" style={{ marginTop: 10 }}>{err.message}</div>}

      <div className="subbox">
        <div className="field" style={{ marginBottom: 8 }}>
          <label>Комментарий к оценке (необязательно)</label>
          <input
            placeholder="Почему верно / ложное срабатывание…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button
            className="btn"
            style={
              v === 'problematic'
                ? { background: 'var(--green)' }
                : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }
            }
            disabled={busy}
            onClick={() => rate(true)}
          >
            Верно (проблема)
          </button>
          <button
            className="btn"
            style={
              v === 'not_problematic'
                ? { background: 'var(--red)' }
                : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }
            }
            disabled={busy}
            onClick={() => rate(false)}
          >
            Ложное срабатывание
          </button>
        </div>
      </div>
    </div>
  )
}

export default function QAStats() {
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sourceFilter, setSourceFilter] = useState('ai')
  const [tab, setTab] = useState('all')
  const reqRef = useRef(0)

  function load() {
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    const filters = sourceFilter !== 'all' ? { source: sourceFilter } : {}
    fetchProblems(filters)
      .then((rows) => {
        if (reqId !== reqRef.current) return
        // Unrated first, then by date descending
        rows.sort((a, b) => {
          if (!a.verdict && b.verdict) return -1
          if (a.verdict && !b.verdict) return 1
          return new Date(b.created_at) - new Date(a.created_at)
        })
        setProblems(rows)
      })
      .catch((e) => reqId === reqRef.current && setError(e))
      .finally(() => reqId === reqRef.current && setLoading(false))
  }

  useEffect(() => {
    load()
    return () => {
      reqRef.current++
    }
  }, [sourceFilter])

  const total = problems.length
  const unrated = problems.filter((p) => !p.verdict).length
  const correct = problems.filter((p) => p.verdict === 'problematic').length
  const incorrect = problems.filter((p) => p.verdict === 'not_problematic').length
  const decided = correct + incorrect
  const pct = decided > 0 ? Math.round((correct / decided) * 10000) / 100 : null

  const pctColor =
    pct === null ? undefined : pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)'

  const tabs = [
    { key: 'all', label: `Все (${total})` },
    { key: 'unrated', label: `Не оценено (${unrated})` },
    { key: 'problematic', label: `Верно (${correct})` },
    { key: 'not_problematic', label: `Ложных (${incorrect})` },
  ]

  const visible = problems.filter((p) => matchFilter(p, tab))

  return (
    <div>
      <h1 className="page-title">QA Точность</h1>
      <p className="page-subtitle">
        Оцените, верно ли обнаружена каждая проблема. Статистика пересчитывается сразу.
      </p>

      <div className="toolbar">
        <div className="field">
          <label>Источник</label>
          <select
            style={{ width: 'auto', minWidth: 200 }}
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value)
              setTab('all')
            }}
          >
            <option value="ai">AI</option>
            <option value="margarita_review">Качество сервиса</option>
            <option value="sona_review">Качество бухгалтерии</option>
            <option value="manual">Вручную</option>
            <option value="all">Все источники</option>
          </select>
        </div>
      </div>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* Stats cards */}
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div className="stat">
              <div className="num">{total}</div>
              <div className="label">Всего проблем</div>
            </div>
            <div className="stat">
              <div className="num">{unrated}</div>
              <div className="label">Не оценено</div>
            </div>
            <div
              className="stat"
              style={
                correct > 0
                  ? { borderColor: '#bbe6c8', background: '#f0faf4' }
                  : undefined
              }
            >
              <div className="num" style={{ color: 'var(--green)' }}>{correct}</div>
              <div className="label">Верно</div>
            </div>
            <div
              className="stat"
              style={
                incorrect > 0
                  ? { borderColor: '#f5c2c2', background: '#fef5f5' }
                  : undefined
              }
            >
              <div className="num" style={{ color: 'var(--red)' }}>{incorrect}</div>
              <div className="label">Ложных</div>
            </div>
            <div
              className="stat"
              style={
                pct !== null
                  ? {
                      borderColor:
                        pct >= 80 ? '#bbe6c8' : pct >= 60 ? '#fcd97a' : '#f5c2c2',
                      background:
                        pct >= 80 ? '#f0faf4' : pct >= 60 ? '#fffbeb' : '#fef5f5',
                    }
                  : undefined
              }
            >
              <div className="num" style={pctColor ? { color: pctColor } : undefined}>
                {pct !== null ? `${pct.toFixed(1)}%` : '—'}
              </div>
              <div className="label">Точность</div>
              {decided > 0 && (
                <div className="hint" style={{ marginTop: 2 }}>
                  Из {decided} оценённых
                </div>
              )}
            </div>
          </div>

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`btn btn-sm ${tab === t.key ? '' : 'btn-secondary'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <Empty text="Нет проблем в этой категории." />
          ) : (
            visible.map((p) => (
              <ProblemCard key={p.problem_id} problem={p} onChanged={load} />
            ))
          )}
        </>
      )}
    </div>
  )
}
