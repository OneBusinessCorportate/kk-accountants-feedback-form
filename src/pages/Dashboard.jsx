import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProblems } from '../lib/api'
import { STATUS, ACCOUNTANT_ACTIONABLE } from '../lib/constants'
import { isOverdue } from '../lib/presentation'
import { keepOwnProblems } from '../lib/scope'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'

export default function Dashboard() {
  const { access, canManage } = useAuth()
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchProblems()
      // Regular accountants only see their own; false positives are excluded.
      .then(
        (data) =>
          active &&
          setProblems(
            keepOwnProblems(data, access).filter((p) => p.verdict !== 'not_problematic'),
          ),
      )
      .catch((e) => active && setError(e))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [access])

  const count = (s) => problems.filter((p) => p.status === s).length

  const actionable = new Set(ACCOUNTANT_ACTIONABLE)
  const overdueNum = problems.filter(
    (p) => actionable.has(p.status) && isOverdue(p),
  ).length

  // Review / Admin are management-only routes; for a scoped accountant send the
  // related tiles to their own queue instead so links never dead-end on a guard.
  const allProblemsTo = canManage ? '/admin' : '/accountant'
  const reviewTo = canManage ? '/review' : '/accountant'

  const stats = [
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
      label: 'Отправлены / на проверке',
      num: count(STATUS.submitted_by_accountant) + count(STATUS.in_review),
      to: reviewTo,
    },
    { label: 'Исправлено', num: count(STATUS.fixed), to: reviewTo },
    { label: 'Принято', num: count(STATUS.explained_accepted), to: reviewTo },
  ]

  return (
    <div>
      <h1 className="page-title">Дашборд</h1>
      <p className="page-subtitle">Обзор проблем клиентов и их статусов.</p>

      <ErrorMessage error={error} />
      {loading ? (
        <Loading />
      ) : (
        <div className="stat-grid">
          {stats.map((s) => (
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
      )}
    </div>
  )
}
