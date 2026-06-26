import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProblems, fetchTasks } from '../lib/api'
import { STATUS, ACCOUNTANT_ACTIONABLE } from '../lib/constants'
import { isOverdue } from '../lib/presentation'
import { keepOwnProblems } from '../lib/scope'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'

function today() {
  return new Date().toISOString().slice(0, 10)
}

export default function Dashboard() {
  const { access, canManage } = useAuth()
  const [problems, setProblems] = useState([])
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    const taskFilters = canManage ? {} : { accountantId: access?.id }
    Promise.all([fetchProblems(), fetchTasks(taskFilters)])
      .then(([p, t]) => {
        if (!active) return
        setProblems(
          keepOwnProblems(p, access).filter(
            (x) => x.verdict !== 'not_problematic' && x.status !== STATUS.auto_resolved,
          ),
        )
        setTasks(t)
      })
      .catch((e) => active && setError(e))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [access, canManage])

  const count = (s) => problems.filter((p) => p.status === s).length

  const actionable = new Set(ACCOUNTANT_ACTIONABLE)
  const overdueNum = problems.filter((p) => actionable.has(p.status) && isOverdue(p)).length

  const allProblemsTo = canManage ? '/admin' : '/accountant'
  const reviewTo = canManage ? '/review' : '/accountant'

  // Problem stats
  const problemStats = [
    { label: 'Всего проблем', num: problems.length, to: allProblemsTo },
    {
      label: 'Ждут бухгалтера',
      num:
        count(STATUS.waiting_for_accountant) +
        count(STATUS.new) +
        count(STATUS.returned_to_accountant),
      to: '/accountant',
    },
    { label: 'Просрочено', num: overdueNum, to: '/accountant', alert: overdueNum > 0 },
    {
      label: 'На проверке',
      num: count(STATUS.submitted_by_accountant) + count(STATUS.in_review),
      to: reviewTo,
    },
    { label: 'Исправлено', num: count(STATUS.fixed), to: reviewTo },
    { label: 'Принято', num: count(STATUS.explained_accepted), to: reviewTo },
  ]

  // Task stats
  const pendingTasks = tasks.filter((t) => !t.done).length
  const overdueTasks = tasks.filter((t) => !t.done && t.due_date && t.due_date < today()).length

  const taskStats = [
    { label: 'Открытых задач', num: pendingTasks, to: '/tasks' },
    { label: 'Просрочено (задачи)', num: overdueTasks, to: '/tasks', alert: overdueTasks > 0 },
  ]

  // Chat timing stats from AI problems
  const unanswered = problems.filter(
    (p) => p.source === 'ai' && p.problem_title?.includes('Без ответа'),
  ).length
  const lateReplies = problems.filter(
    (p) => p.source === 'ai' && p.problem_title?.includes('Поздний ответ'),
  ).length
  const overduePromises = problems.filter(
    (p) => p.source === 'ai' && p.problem_title?.includes('обещание'),
  ).length

  const chatStats = [
    { label: 'Без ответа (AI)', num: unanswered, to: allProblemsTo, alert: unanswered > 0 },
    { label: 'Поздний ответ (AI)', num: lateReplies, to: allProblemsTo, alert: lateReplies > 0 },
    { label: 'Невыполн. обещания', num: overduePromises, to: allProblemsTo, alert: overduePromises > 0 },
  ]

  return (
    <div>
      <h1 className="page-title">Дашборд</h1>
      <p className="page-subtitle">Обзор проблем, задач и чатов.</p>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="stat-grid">
            {problemStats.map((s) => (
              <Link
                key={s.label}
                to={s.to}
                className={s.alert ? 'stat stat-alert' : 'stat'}
                style={{ textDecoration: 'none' }}
              >
                <div className="num">{s.num}</div>
                <div className="label">{s.label}</div>
              </Link>
            ))}
          </div>

          <div className="section-label">Задачи</div>
          <div className="stat-grid" style={{ marginBottom: 28 }}>
            {taskStats.map((s) => (
              <Link
                key={s.label}
                to={s.to}
                className={s.alert ? 'stat stat-alert' : 'stat'}
                style={{ textDecoration: 'none' }}
              >
                <div className="num">{s.num}</div>
                <div className="label">{s.label}</div>
              </Link>
            ))}
          </div>

          <div className="section-label">Проблемные чаты (AI)</div>
          <div className="stat-grid">
            {chatStats.map((s) => (
              <Link
                key={s.label}
                to={s.to}
                className={s.alert ? 'stat stat-alert' : 'stat'}
                style={{ textDecoration: 'none' }}
              >
                <div className="num">{s.num}</div>
                <div className="label">{s.label}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
