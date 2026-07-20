import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProblems, fetchChats, fetchTasks, fetchPraise } from '../lib/api'
import {
  DASHBOARD_SOURCES,
  PERIODS,
  prepareDashboard,
  formatDate,
  formatBusinessAge,
  isOverdue,
  urgencyLevel,
} from '../lib/dashboard'
import { SOURCE_LABELS, URGENCY, URGENCY_LABELS, URGENCY_BADGE } from '../lib/constants'
import { keepOwnProblems } from '../lib/scope'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage, Empty } from '../components/States'

function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Yerevan' }) // YYYY-MM-DD
}

// The clickable categories. Each maps to a slice of the prepared data. `sel`
// pulls the matching list out of prepareDashboard()'s result.
const CATEGORIES = [
  { key: 'urgent', label: 'ОЧЕНЬ СРОЧНО', sel: (d) => d.byCategory.urgent, alert: true },
  { key: 'total', label: 'Все активные', sel: (d) => d.active },
  { key: 'violation', label: 'Нарушения', sel: (d) => d.byCategory.violation },
  { key: 'quality', label: 'Оценка качества', sel: (d) => d.byCategory.quality },
  { key: 'sona', label: 'Качество бухгалтерской работы', sel: (d) => d.byCategory.sona },
  { key: 'sla', label: 'SLA (сроки)', sel: (d) => d.byCategory.sla },
  { key: 'overdue', label: 'Просрочено', sel: (d) => d.byCategory.overdue, alert: true },
  { key: 'needsReview', label: 'Требует проверки', sel: (d) => d.needsReview },
]

export default function Dashboard() {
  const { access, canManage } = useAuth()
  const [problems, setProblems] = useState([])
  const [chats, setChats] = useState([])
  const [tasks, setTasks] = useState([])
  const [praise, setPraise] = useState([])
  const [period, setPeriod] = useState('week')
  const [active, setActive] = useState(null) // selected category key, or null
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    // Fetch ONLY the dashboard sources (Margarita + Sona) — never AI — plus the
    // kk-soprovozhdeniya chat directory and the real tasks.
    Promise.all([
      fetchProblems({ sourceIn: DASHBOARD_SOURCES }),
      fetchChats().catch(() => []),
      fetchTasks(canManage ? {} : { accountantId: access?.employee_id }),
      fetchPraise(canManage ? {} : { accountantId: access?.employee_id }).catch(() => []),
    ])
      .then(([p, c, t, pr]) => {
        if (!alive) return
        setProblems(keepOwnProblems(p, access))
        setChats(c)
        setTasks(t)
        setPraise(pr)
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [access, canManage])

  // Everything recomputes when the period changes — cards, list, counts.
  const data = useMemo(
    () => prepareDashboard({ problems, chats, period, now: new Date() }),
    [problems, chats, period],
  )

  const today = localToday()
  // Open = still needs work; a cancelled task (done=false, status='cancelled')
  // is finished, so it must not count as open.
  const openTasks = tasks.filter((t) => !t.done && t.status !== 'cancelled')
  const overdueTasks = openTasks.filter((t) => {
    const due = t.due_date_postponed || t.due_date
    return due && due < today
  })

  const selected = active ? CATEGORIES.find((c) => c.key === active) : null
  const list = selected ? selected.sel(data) : []

  return (
    <div>
      <h1 className="page-title">Дашборд</h1>
      <p className="page-subtitle">
        Только результаты проверки качества · активные чаты · рабочее время 10:00–13:00, 14:00–19:00.
      </p>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          {/* Period filter — really changes the data below. */}
          <div className="period-pills">
            {PERIODS.map(({ key, label }) => (
              <button
                key={key}
                className={`btn btn-sm ${period === key ? '' : 'btn-secondary'}`}
                onClick={() => setPeriod(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Category cards. Clicking one shows ONLY that category below. */}
          <div className="stat-grid">
            {CATEGORIES.map((c) => {
              const num = c.sel(data).length
              const isActive = active === c.key
              const alert = c.alert && num > 0
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setActive(isActive ? null : c.key)}
                  className={`stat${alert ? ' stat-alert' : ''}`}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: isActive ? '2px solid var(--accent, #2563eb)' : undefined,
                  }}
                >
                  <div className="num">{num}</div>
                  <div className="label">{c.label}</div>
                </button>
              )
            })}
          </div>

          {/* Task stats come only from real kk_tasks — never auto-created from AI. */}
          <div className="section-label">Задачи</div>
          <div className="stat-grid" style={{ marginBottom: 28 }}>
            <Link to="/tasks" className="stat" style={{ textDecoration: 'none' }}>
              <div className="num">{openTasks.length}</div>
              <div className="label">Открытых задач</div>
            </Link>
            <Link
              to="/tasks"
              className={overdueTasks.length > 0 ? 'stat stat-alert' : 'stat'}
              style={{ textDecoration: 'none' }}
            >
              <div className="num">{overdueTasks.length}</div>
              <div className="label">Просрочено (задачи)</div>
            </Link>
            <Link to="/clients" className="stat" style={{ textDecoration: 'none' }}>
              <div className="num">{new Set(data.active.map((p) => p.client_name)).size}</div>
              <div className="label">Клиенты</div>
            </Link>
            <div className="stat" title="Положительные результаты проверки качества — не тикеты">
              <div className="num" style={{ color: 'var(--green, #16a34a)' }}>👍 {praise.length}</div>
              <div className="label">Похвалы (позитив)</div>
            </div>
          </div>

          {/* Drill-down: only the chosen category, nothing before a click. */}
          {selected ? (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                }}
              >
                <h3 className="card-title">
                  {selected.label} — {list.length}
                </h3>
                <button className="btn btn-secondary btn-sm" onClick={() => setActive(null)}>
                  Скрыть
                </button>
              </div>
              <ProblemTable rows={list} showReason={selected.key === 'needsReview'} />
            </>
          ) : (
            <p className="hint">Нажмите на категорию выше, чтобы увидеть только её данные.</p>
          )}
        </>
      )}
    </div>
  )
}

function ProblemTable({ rows, showReason }) {
  if (!rows || rows.length === 0) return <Empty text="Нет данных в этой категории." />
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Клиент</th>
            <th>Проблема</th>
            <th>Источник</th>
            <th>Бухгалтер</th>
            <th>Дата</th>
            <th>Возраст</th>
            {showReason && <th>Причина</th>}
            <th>Чат</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const overdue = !showReason && isOverdue(p)
            return (
              <tr key={p.problem_id} style={overdue ? { background: '#fff5f5' } : undefined}>
                <td style={{ fontWeight: 600 }}>
                  {p.client_name || '—'}
                  {p.contract_id && (
                    <span className="contract-id" style={{ marginLeft: 6 }}>
                      {p.contract_id}
                    </span>
                  )}
                </td>
                <td>
                  {!showReason &&
                    (() => {
                      const u = p.urgency || urgencyLevel(p)
                      return u !== URGENCY.normal ? (
                        <span
                          className={`badge ${URGENCY_BADGE[u]}`}
                          style={{ marginRight: 6 }}
                        >
                          {URGENCY_LABELS[u]}
                        </span>
                      ) : null
                    })()}
                  {p.problem_title || '—'}
                </td>
                <td>{(p.sources || [p.source]).map((s) => SOURCE_LABELS[s] || s).join(', ')}</td>
                <td>
                  {p.accountant_name || <span style={{ color: 'var(--muted)' }}>не определён</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDate(p.detected_at) || '—'}</td>
                <td
                  style={{
                    whiteSpace: 'nowrap',
                    color: overdue ? 'var(--red)' : undefined,
                    fontWeight: overdue ? 600 : undefined,
                  }}
                >
                  {formatBusinessAge(p.detected_at)}
                </td>
                {showReason && (
                  <td style={{ color: 'var(--muted)' }}>{p.review_reason || '—'}</td>
                )}
                <td>
                  {p.chat_link ? (
                    <a href={p.chat_link} target="_blank" rel="noreferrer">
                      → чат
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
