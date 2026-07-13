import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchAppeals, fetchProblems, resolveAppeal, createTask, setProblemPenalty } from '../lib/api'
import { APPEAL_STATUS_LABELS, APPEAL_STATUS_BADGE, SOURCE_LABELS } from '../lib/constants'
import { formatDate } from '../lib/presentation'
import { useAuth } from '../lib/AuthContext'
import StatusBadge from '../components/StatusBadge'
import { Loading, ErrorMessage, Empty } from '../components/States'

// Margarita / management review of accountant appeals. Pending appeals are
// surfaced first and counted so they are easy to notice (req 7).
export default function Appeals() {
  const [appeals, setAppeals] = useState([])
  const [problems, setProblems] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('pending')
  const [accountantFilter, setAccountantFilter] = useState('')
  const reqRef = useRef(0)

  function load() {
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    Promise.all([fetchAppeals(), fetchProblems({})])
      .then(([ap, probs]) => {
        if (reqId !== reqRef.current) return
        const map = new Map()
        for (const p of probs) map.set(p.problem_id, p)
        setProblems(map)
        setAppeals(ap)
      })
      .catch((e) => reqId === reqRef.current && setError(e))
      .finally(() => reqId === reqRef.current && setLoading(false))
  }

  useEffect(() => {
    load()
    return () => {
      reqRef.current++
    }
  }, [])

  const accountants = useMemo(() => {
    const map = new Map()
    for (const a of appeals) {
      const name = a.accountant_name || a.accountant_id
      if (name && !map.has(name)) map.set(name, name)
    }
    return [...map.keys()].sort()
  }, [appeals])

  const pendingCount = appeals.filter((a) => a.status === 'pending').length

  // Newest first, but always float pending appeals to the top.
  const visible = useMemo(() => {
    let list = appeals
    if (statusFilter) list = list.filter((a) => a.status === statusFilter)
    if (accountantFilter)
      list = list.filter((a) => (a.accountant_name || a.accountant_id) === accountantFilter)
    return [...list].sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1
      if (b.status === 'pending' && a.status !== 'pending') return 1
      return a.created_at < b.created_at ? 1 : -1
    })
  }, [appeals, statusFilter, accountantFilter])

  return (
    <div>
      <h1 className="page-title">Апелляции</h1>
      <p className="page-subtitle">
        Рассмотрение апелляций бухгалтеров по проблемам качества. Одобрение снимает
        проблему, отклонение оставляет её активной.
      </p>

      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className={`stat ${pendingCount > 0 ? 'stat-alert' : ''}`}>
          <div className="num">{pendingCount}</div>
          <div className="label">Ожидают решения</div>
        </div>
        <div className="stat">
          <div className="num">{appeals.filter((a) => a.status === 'approved').length}</div>
          <div className="label">Одобрено</div>
        </div>
        <div className="stat">
          <div className="num">{appeals.filter((a) => a.status === 'rejected').length}</div>
          <div className="label">Отклонено</div>
        </div>
        <div className="stat">
          <div className="num">{appeals.length}</div>
          <div className="label">Всего</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="field" style={{ marginBottom: 0, minWidth: 180 }}>
          <label>Статус апелляции</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Все</option>
            <option value="pending">На рассмотрении</option>
            <option value="approved">Одобрены</option>
            <option value="rejected">Отклонены</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0, minWidth: 180 }}>
          <label>Бухгалтер</label>
          <select value={accountantFilter} onChange={(e) => setAccountantFilter(e.target.value)}>
            <option value="">Все бухгалтеры</option>
            {accountants.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <Empty text="Апелляций по фильтру нет." />
      ) : (
        visible.map((a) => (
          <AppealCard key={a.id} appeal={a} problem={problems.get(a.problem_id)} onChanged={load} />
        ))
      )}
    </div>
  )
}

function AppealCard({ appeal, problem, onChanged }) {
  const { access } = useAuth()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [taskCreated, setTaskCreated] = useState(false)
  const [penalty, setPenalty] = useState(
    problem?.penalty_amount != null ? String(problem.penalty_amount) : '',
  )
  const [penaltySaved, setPenaltySaved] = useState(false)

  const isPending = appeal.status === 'pending'
  const penaltyCancelled = !!problem?.penalty_cancelled
  const penaltyAmount = problem?.penalty_amount

  async function savePenalty() {
    setBusy(true)
    setError(null)
    try {
      await setProblemPenalty({ problemId: appeal.problem_id, amount: penalty.trim() })
      setPenaltySaved(true)
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  async function decide(decision) {
    setBusy(true)
    setError(null)
    try {
      await resolveAppeal({
        appealId: appeal.id,
        problemId: appeal.problem_id,
        decision,
        resolvedBy: access?.full_name || null,
        resolutionComment: comment.trim() || null,
      })
      onChanged()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  // Turn the disputed issue into a follow-up task for the accountant (req 5).
  async function makeTask() {
    setBusy(true)
    setError(null)
    try {
      const client = problem?.client_name || appeal.accountant_name || ''
      await createTask({
        task_type: 'qa',
        status: 'open',
        title: problem?.problem_title
          ? `QA: ${problem.problem_title}`
          : 'Задача по проблеме качества',
        client_name: client || null,
        chat_link: problem?.chat_link || null,
        accountant_id: appeal.accountant_id || problem?.accountant_id || null,
        accountant_name: appeal.accountant_name || problem?.accountant_name || null,
        notes: problem?.problem_description || null,
        problem_id: appeal.problem_id,
        created_by: access?.full_name || null,
      })
      setTaskCreated(true)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`card ${isPending ? 'card-prio-1' : ''}`}>
      <div className="card-head">
        <h3 className="card-title">
          {problem?.problem_title || appeal.problem_id}
          {problem?.client_name && <span className="title-client"> — {problem.client_name}</span>}
        </h3>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`badge ${APPEAL_STATUS_BADGE[appeal.status] || 'badge-gray'}`}>
            {APPEAL_STATUS_LABELS[appeal.status] || appeal.status}
          </span>
          {problem && <StatusBadge status={problem.status} />}
        </span>
      </div>

      <div className="meta">
        <span>
          Бухгалтер: <b>{appeal.accountant_name || appeal.accountant_id || '—'}</b>
        </span>
        {problem?.source && (
          <span>
            Источник: <b>{SOURCE_LABELS[problem.source] || problem.source}</b>
          </span>
        )}
        <span>
          Дата апелляции: <b>{formatDate(appeal.created_at)}</b>
        </span>
        {problem?.chat_link && (
          <span>
            <a href={problem.chat_link} target="_blank" rel="noreferrer">
              Открыть чат ↗
            </a>
          </span>
        )}
      </div>

      {problem?.problem_description && <div className="description">{problem.problem_description}</div>}

      <div className="subbox">
        <h4 style={{ marginTop: 0 }}>Апелляция бухгалтера</h4>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{appeal.comment}</p>
      </div>

      {/* Fine / penalty (req 4). Одобрение апелляции автоматически снимает штраф. */}
      <div className="subbox">
        <h4 style={{ marginTop: 0 }}>Штраф</h4>
        {penaltyAmount ? (
          <p style={{ margin: '0 0 8px' }}>
            Текущий штраф:{' '}
            <b style={penaltyCancelled ? { textDecoration: 'line-through', color: 'var(--muted)' } : {}}>
              {new Intl.NumberFormat('ru-RU').format(penaltyAmount)}
            </b>
            {penaltyCancelled && <span className="badge badge-green" style={{ marginLeft: 8 }}>Снят</span>}
          </p>
        ) : (
          <p className="hint" style={{ margin: '0 0 8px' }}>Штраф не назначен.</p>
        )}
        {isPending && (
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Сумма штрафа (одобрение апелляции снимет штраф)</label>
            <div className="btn-row" style={{ marginTop: 4 }}>
              <input
                type="number"
                min="0"
                style={{ maxWidth: 160 }}
                value={penalty}
                onChange={(e) => {
                  setPenalty(e.target.value)
                  setPenaltySaved(false)
                }}
                placeholder="0"
              />
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={savePenalty}>
                {penaltySaved ? 'Сохранено ✓' : 'Сохранить штраф'}
              </button>
            </div>
          </div>
        )}
      </div>

      {!isPending && (
        <div className="subbox">
          <div className="meta">
            <span>
              Решение: <b>{APPEAL_STATUS_LABELS[appeal.status]}</b>
            </span>
            {appeal.resolved_at && (
              <span>
                Дата: <b>{formatDate(appeal.resolved_at)}</b>
              </span>
            )}
          </div>
          {appeal.resolution_comment && (
            <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{appeal.resolution_comment}</p>
          )}
        </div>
      )}

      <ErrorMessage error={error} />

      {isPending && (
        <div className="subbox">
          <div className="field">
            <label>Комментарий к решению (необязательно)</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Пояснение для бухгалтера"
            />
          </div>
          <div className="btn-row">
            <button className="btn btn-green" disabled={busy} onClick={() => decide('approved')}>
              Одобрить апелляцию
            </button>
            <button className="btn btn-amber" disabled={busy} onClick={() => decide('rejected')}>
              Отклонить апелляцию
            </button>
          </div>
        </div>
      )}

      <div className="btn-row">
        <button
          className="btn btn-secondary btn-sm"
          disabled={busy || taskCreated}
          onClick={makeTask}
        >
          {taskCreated ? 'Задача создана ✓' : '+ Создать задачу бухгалтеру'}
        </button>
      </div>
    </div>
  )
}
