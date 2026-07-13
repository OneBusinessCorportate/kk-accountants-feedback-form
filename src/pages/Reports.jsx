import { Fragment, useEffect, useMemo, useState } from 'react'
import { fetchProblems, fetchAppeals, fetchAcknowledgements, fetchMargaritaChecks } from '../lib/api'
import { DASHBOARD_SOURCES, PERIODS, periodStart, inPeriod, formatDate } from '../lib/dashboard'
import { buildWorkReport, MARGARITA_SOURCE } from '../lib/reports'
import StatusBadge from '../components/StatusBadge'
import { Loading, ErrorMessage, Empty } from '../components/States'

function fmtMoney(n) {
  if (!n) return '0'
  return new Intl.NumberFormat('ru-RU').format(n)
}

// Management view: how much QA work Margarita produced and how each accountant
// stands. All figures are derived from problems + appeals + acknowledgements +
// her per-chat scorecards (no stats table). «Работа Маргариты» scopes to her
// review source; «По бухгалтерам» covers every quality-review source.
export default function Reports() {
  const [problems, setProblems] = useState([])
  const [appeals, setAppeals] = useState([])
  const [acks, setAcks] = useState([])
  const [checks, setChecks] = useState([])
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
      fetchMargaritaChecks().catch(() => []),
    ])
      .then(([p, ap, ac, ch]) => {
        setProblems(p)
        setAppeals(ap)
        setAcks(ac)
        setChecks(ch)
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
    // Checked-chats are Margarita's; only meaningful in her scope, filtered by
    // the check date.
    const scopedChecks =
      scope === 'margarita'
        ? checks.filter((c) => !start || (c.checking_date && new Date(c.checking_date) >= start))
        : []
    return buildWorkReport({
      problems: scopedProblems,
      appeals: scopedAppeals,
      acks: scopedAcks,
      checks: scopedChecks,
    })
  }, [problems, appeals, acks, checks, period, scope])

  const isMargarita = scope === 'margarita'

  return (
    <div>
      <h1 className="page-title">Отчёты</h1>
      <p className="page-subtitle">
        Объём проверок Маргариты и статус по каждому бухгалтеру: проверенные чаты,
        замечания, апелляции, ознакомления, штрафы и открытые вопросы.
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
          {/* A. General Margarita work-volume card (req 2) with the exact wording. */}
          {isMargarita && (
            <div className="card" style={{ marginTop: 8 }}>
              <h2 className="section-label" style={{ marginTop: 0 }}>Объём работы Маргариты</h2>
              <div className="stat-grid">
                <div className="stat">
                  <div className="num">{report.chatsChecked}</div>
                  <div className="label">Проверено чатов</div>
                </div>
                <div className="stat">
                  <div className="num">{report.issuesCreated}</div>
                  <div className="label">Создано замечаний / тикетов</div>
                </div>
                <div className="stat">
                  <div className="num">{report.appeals.total}</div>
                  <div className="label">Получено апелляций</div>
                </div>
                <div className="stat">
                  <div className="num">{report.appeals.approved}</div>
                  <div className="label">Подтверждено апелляций</div>
                </div>
                <div className="stat">
                  <div className="num">{report.appeals.rejected}</div>
                  <div className="label">Отклонено апелляций</div>
                </div>
                <div className={`stat ${report.appeals.pending > 0 ? 'stat-alert' : ''}`}>
                  <div className="num">{report.appeals.pending}</div>
                  <div className="label">Ожидают рассмотрения</div>
                </div>
              </div>
              {(report.finesActive > 0 || report.finesCancelled > 0) && (
                <p className="hint" style={{ margin: '8px 0 0' }}>
                  Штрафы: активных <b>{fmtMoney(report.finesActive)}</b>, снято после апелляций{' '}
                  <b>{fmtMoney(report.finesCancelled)}</b>
                </p>
              )}
            </div>
          )}

          {!isMargarita && (
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
          )}

          {/* B. Report by each accountant (req 1/5). */}
          <h2 className="section-label" style={{ marginTop: 24 }}>По бухгалтерам</h2>
          {report.byAccountant.length === 0 ? (
            <Empty text="Нет данных за выбранный период." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Бухгалтер</th>
                    <th>Замечания</th>
                    <th>Ознакомлено</th>
                    <th>Открыто</th>
                    <th>Апелляции</th>
                    <th>Одобрено</th>
                    <th>Отклонено</th>
                    <th>Ожидают</th>
                    <th>Наруш. активны</th>
                    <th>Снято</th>
                    <th>Штраф активен</th>
                    <th>Штраф снят</th>
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
                          {r.pending > 0 ? (
                            <span className="badge badge-amber">{r.pending}</span>
                          ) : (
                            0
                          )}
                        </td>
                        <td>{r.activeViolations}</td>
                        <td>{r.cancelledViolations}</td>
                        <td>{fmtMoney(r.finesActive)}</td>
                        <td>{fmtMoney(r.finesCancelled)}</td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setExpanded(expanded === r.accountantName ? null : r.accountantName)
                            }
                          >
                            {expanded === r.accountantName ? 'Скрыть' : 'Замечания'}
                          </button>
                        </td>
                      </tr>
                      {expanded === r.accountantName && (
                        <tr>
                          <td colSpan={13} style={{ background: 'var(--bg-soft, #f8f8f8)' }}>
                            <div className="table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Замечание</th>
                                    <th>Клиент</th>
                                    <th>Статус</th>
                                    <th>Апелляции</th>
                                    <th>Штраф</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.items.map((it) => (
                                    <tr key={it.problem_id}>
                                      <td style={{ maxWidth: 320, whiteSpace: 'normal' }}>{it.title}</td>
                                      <td>{it.client_name || '—'}</td>
                                      <td><StatusBadge status={it.status} /></td>
                                      <td>{it.appeals || 0}</td>
                                      <td>
                                        {it.penalty_amount ? (
                                          <span
                                            style={
                                              it.penalty_cancelled
                                                ? { textDecoration: 'line-through', color: 'var(--muted)' }
                                                : {}
                                            }
                                          >
                                            {fmtMoney(it.penalty_amount)}
                                          </span>
                                        ) : (
                                          '—'
                                        )}
                                      </td>
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

          {/* B'. Checked chats by accountant (Margarita scope). */}
          {isMargarita && report.checksByAccountant.length > 0 && (
            <>
              <h2 className="section-label" style={{ marginTop: 24 }}>
                Проверено чатов по бухгалтерам
              </h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Бухгалтер</th>
                      <th>Проверено чатов</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.checksByAccountant.map((r) => (
                      <tr key={r.accountantName}>
                        <td>{r.accountantName}</td>
                        <td>{r.chatsChecked}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* C/D. Daily + period report (req 1). */}
          <h2 className="section-label" style={{ marginTop: 24 }}>По датам</h2>
          {report.issuesByDay.length === 0 && report.checksByDay.length === 0 ? (
            <Empty text="Нет данных." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Дата</th>
                    {isMargarita && <th>Проверено чатов</th>}
                    <th>Замечаний создано</th>
                    <th>Апелляций</th>
                  </tr>
                </thead>
                <tbody>
                  {mergeDays(report, isMargarita).map((d) => (
                    <tr key={d.date}>
                      <td>{formatDate(d.date)}</td>
                      {isMargarita && <td>{d.checks}</td>}
                      <td>{d.issues}</td>
                      <td>{d.appeals}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Merge the per-day series (checks / issues / appeals) into one table, newest
// day first.
function mergeDays(report, includeChecks) {
  const days = new Map()
  const add = (arr, field) => {
    for (const row of arr) {
      if (!days.has(row.date)) days.set(row.date, { date: row.date, checks: 0, issues: 0, appeals: 0 })
      days.get(row.date)[field] = row.count
    }
  }
  if (includeChecks) add(report.checksByDay, 'checks')
  add(report.issuesByDay, 'issues')
  add(report.appealsByDay, 'appeals')
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
}
