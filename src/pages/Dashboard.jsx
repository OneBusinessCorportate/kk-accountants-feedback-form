import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProblems } from '../lib/api'
import { STATUS, ACCOUNTANT_ACTIONABLE } from '../lib/constants'
import { isOverdue } from '../lib/presentation'
import { Loading, ErrorMessage } from '../components/States'

export default function Dashboard() {
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchProblems()
      .then((data) => active && setProblems(data))
      .catch((e) => active && setError(e))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  const count = (s) => problems.filter((p) => p.status === s).length

  const actionable = new Set(ACCOUNTANT_ACTIONABLE)
  const overdueNum = problems.filter(
    (p) => actionable.has(p.status) && isOverdue(p),
  ).length

  const stats = [
    { label: 'Всего проблем', num: problems.length, to: '/admin' },
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
      to: '/review',
    },
    { label: 'Исправлено', num: count(STATUS.fixed), to: '/review' },
    { label: 'Принято', num: count(STATUS.explained_accepted), to: '/review' },
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
