import { Fragment, useEffect, useMemo, useState } from 'react'
import { fetchProblems, fetchAppeals, fetchAcknowledgements } from '../lib/api'
import { DASHBOARD_SOURCES, PERIODS, periodStart, inPeriod, formatDate } from '../lib/dashboard'
import { buildWorkReport, MARGARITA_SOURCE } from '../lib/reports'
import { STATUS_LABELS } from '../lib/constants'
import StatusBadge from '../components/StatusBadge'
import { Loading, ErrorMessage, Empty } from '../components/States'

// Management view: how much QA work Margarita produced and how each accountant
// stands. All figures are derived from problems + appeals + acknowledgements
// (no stats table). «Работа Маргариты» scopes to her review source; «По
// бухгалтерам» covers every quality-review source.
export default function Reports() {
  const [problems, setProblems] = useState([])
  const [appeals, setAppeals] = useState([])
  const [acks, setAcks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [period, setPeriod] = useState('all')
  const [scope, setScope] = useState('margarita') // 'margarita' | 'all'
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchProblems({ sourceIn: DASHBOARD_SOURCES }),
      fetchAppeals(),
      fetchAcknowledgements(),
    ])
      .then(([p, ap, ac]) => {
        setProblems(p)
        setAppeals(ap)
        setAcks(ac)
      })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  const report = useMemo(() => {
    const now = new Date()
    const start = periodStart(period, now)
    const inScope = (p) => (scope === 'margarita' ? p.source === MARGARITA_SOURCE : true)
    const scopedProblems = problems.filter((p) => inScope(p) && inPeriod(p, period, now))
    const problemIds = new Set(scopedProblems.map((p) => p.problem_id))
    // Appeals / acks are attributed to the issues in scope + period.
    const scopedAppeals = appeals.filter(
      (a) => problemIds.has(a.problem_id) && (!start || new Date(a.created_at) >= start),
    )
    const scopedAcks = acks.filter((a) => problemIds.has(a.problem_id))
    return buildWorkReport({ problems: scopedProblems, appeals: scopedAppeals, acks: scopedAcks })
  }, [problems, appeals, acks, period, scope])

  return (
    <div>
      <h1 className="page-title">Отчёты</h1>
      <p className="page-subtitle">
        Объём проверок Маргариты и статус по каждому бухгалтеру: проблемы, апелляции,
        ознакомления и открытые вопросы.
      </p>

      <div className="toolbar">
        <div className="field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label>Источник</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="margarita">Только проверки Маргариты</option>
            <option value="all">Все проверки качества</option>
          </select>
        </div>
      </div>

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

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="stat-grid" style={{ marginTop: 8 }}>
            <div className="stat">
              <div className="num">{report.issuesCreated}</div>
              <div className="label">Проблем создано</div>
            </div>
            <div className="stat">
              <div className="num">{report.acknowledged}</div>
              <div className="label">Ознакомлений</div>
            </div>
            <div className="stat">
              <div className="num">{report.appeals.total}</div>
              <div className="label">Апелляций</div>
            </div>
            <div className={`stat ${report.appeals.pending > 0 ? 'stat-alert' : ''}`}>
              <div className="num">{report.appeals.pending}</div>
              <div className="label">Ожидают решения</div>
            </div>
            <div className="stat">
              <div className="num">{report.appeals.approved}</div>
              <div className="label">Апелляций одобрено</div>
            </div>
            <div className="stat">
              <div className="num">{report.appeals.rejected}</div>
              <div className="label">Апелляций отклонено</div>
            </div>
          </div>

          <h2 className="section-label" style={{ marginTop: 24 }}>По бухгалтерам</h2>
          {report.byAccountant.length === 0 ? (
            <Empty text="Нет данных за выбранный период." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Бухгалтер</th>
                    <th>Проблемы</th>
                    <th>Ознакомлено</th>
                    <th>Открыто</th>
                    <th>Апелляции</th>
                    <th>Одобрено</th>
                    <th>Отклонено</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {report.byAccountant.map((r) => (
                    <Fragment key={r.accountantName}>
                      <tr>
                        <td><b>{r.accountantName}</b></td>
                        <td>{r.issues}</td>
                        <td>{r.reviewed}</td>
                        <td>
                          {r.open > 0 ? (
                            <span className="badge badge-amber">{r.open}</span>
                          ) : (
                            <span className="badge badge-green">0</span>
                          )}
                        </td>
                        <td>{r.appeals}</td>
                        <td>{r.approved}</td>
                        <td>{r.rejected}</td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setExpanded(expanded === r.accountantName ? null : r.accountantName)
                            }
                          >
                            {expanded === r.accountantName ? 'Скрыть' : 'Проблемы'}
                          </button>
                        </td>
                      </tr>
                      {expanded === r.accountantName && (
                        <tr>
                          <td colSpan={8} style={{ background: 'var(--bg-soft, #f8f8f8)' }}>
                            <div className="table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Проблема</th>
                                    <th>Клиент</th>
                                    <th>Статус</th>
                                    <th>Апелляции</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.items.map((it) => (
                                    <tr key={it.problem_id}>
                                      <td style={{ maxWidth: 320, whiteSpace: 'normal' }}>{it.title}</td>
                                      <td>{it.client_name || '—'}</td>
                                      <td><StatusBadge status={it.status} /></td>
                                      <td>{it.appeals || 0}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="section-label" style={{ marginTop: 24 }}>Проблемы по датам</h2>
          {report.issuesByDay.length === 0 ? (
            <Empty text="Нет данных." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Проблем создано</th>
                    <th>Апелляций</th>
                  </tr>
                </thead>
                <tbody>
                  {report.issuesByDay.map((d) => {
                    const ap = report.appealsByDay.find((x) => x.date === d.date)
                    return (
                      <tr key={d.date}>
                        <td>{formatDate(d.date)}</td>
                        <td>{d.count}</td>
                        <td>{ap ? ap.count : 0}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
