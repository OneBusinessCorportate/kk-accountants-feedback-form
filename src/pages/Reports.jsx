import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  fetchProblems,
  fetchAppeals,
  fetchAcknowledgements,
  fetchMargaritaChecks,
  fetchSonaChecks,
  fetchPraise,
} from '../lib/api'
import { DASHBOARD_SOURCES, PERIODS, periodStart, inPeriod, formatDate } from '../lib/dashboard'
import { buildWorkReport, buildSonaReport, MARGARITA_SOURCE } from '../lib/reports'
import { buildQualityReport, urgentIssues } from '../lib/qualityReport'
import { formatQualityReport } from '../lib/telegramReport'
import StatusBadge from '../components/StatusBadge'
import { Loading, ErrorMessage, Empty } from '../components/States'

// Scope selector: one combined department report (the daily «один отчёт по
// отделу и по каждому бухгалтеру»), or the individual work reports.
const SCOPES = [
  { key: 'department', label: 'Отдел (общий отчёт)' },
  { key: 'sona', label: 'Работа Соны' },
  { key: 'margarita', label: 'Работа Маргариты' },
  { key: 'all', label: 'Все проверки качества' },
]

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
  const [sonaChecks, setSonaChecks] = useState([])
  const [praise, setPraise] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [period, setPeriod] = useState('all')
  const [scope, setScope] = useState('department')
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchProblems({ sourceIn: DASHBOARD_SOURCES }),
      fetchAppeals(),
      fetchAcknowledgements(),
      fetchMargaritaChecks().catch(() => []),
      fetchSonaChecks().catch(() => []),
      fetchPraise().catch(() => []),
    ])
      .then(([p, ap, ac, ch, sc, pr]) => {
        setProblems(p)
        setAppeals(ap)
        setAcks(ac)
        setChecks(ch)
        setSonaChecks(sc)
        setPraise(pr)
      })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  // Period-scoped slices shared by the department + Sona reports.
  const scoped = useMemo(() => {
    const now = new Date()
    const start = periodStart(period, now)
    const afterStart = (d) => !start || (d && new Date(d) >= start)
    return {
      problems: problems.filter((p) => inPeriod(p, period, now)),
      praise: praise.filter((p) => afterStart(p.detected_at || p.created_at)),
      sonaChecks: sonaChecks.filter((c) => afterStart(c.checking_date)),
      margaritaChecks: checks.filter((c) => afterStart(c.checking_date)),
    }
  }, [problems, praise, sonaChecks, checks, period])

  const deptReport = useMemo(
    () =>
      buildQualityReport({
        problems: scoped.problems,
        praise: scoped.praise,
        sonaChecks: scoped.sonaChecks,
        margaritaChecks: scoped.margaritaChecks,
        now: new Date(),
      }),
    [scoped],
  )
  const urgentList = useMemo(() => urgentIssues(scoped.problems, new Date()), [scoped.problems])
  const sonaReport = useMemo(() => buildSonaReport({ checks: scoped.sonaChecks }), [scoped.sonaChecks])
  const telegramPreview = useMemo(
    () =>
      formatQualityReport({
        periodLabel: PERIODS.find((p) => p.key === period)?.label || 'за период',
        report: deptReport,
        urgent: urgentList,
        sona: sonaReport,
      }),
    [deptReport, urgentList, sonaReport, period],
  )

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
  const isLegacy = scope === 'margarita' || scope === 'all'

  return (
    <div>
      <h1 className="page-title">Отчёты</h1>
      <p className="page-subtitle">
        Единый отчёт по качеству бухгалтерских услуг: по отделу и по каждому
        бухгалтеру — замечания, «ОЧЕНЬ СРОЧНО», похвалы, проверки Соны и Маргариты.
        Обновляется по периоду (день / неделя / всё время).
      </p>

      <div className="toolbar">
        <div className="field" style={{ marginBottom: 0, minWidth: 200 }}>
          <label>Источник</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            {SCOPES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
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
          {/* Department combined report — one report by department + per accountant. */}
          {scope === 'department' && (
            <DepartmentReport report={deptReport} urgent={urgentList} telegram={telegramPreview} />
          )}

          {/* Sona work report — «Объём работы Соны». */}
          {scope === 'sona' && <SonaReport report={sonaReport} />}

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

          {scope === 'all' && (
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
          {isLegacy && (
          <><h2 className="section-label" style={{ marginTop: 24 }}>По бухгалтерам</h2>
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

// ---- Combined department report --------------------------------------------
// One report for the whole department + each accountant, merging problems,
// praise and checks (Sona + Margarita), plus the «ОЧЕНЬ СРОЧНО» list and a
// preview of the Telegram message sent daily / weekly to ОК.
function DepartmentReport({ report, urgent, telegram }) {
  const d = report.department
  return (
    <>
      <div className="card" style={{ marginTop: 8 }}>
        <h2 className="section-label" style={{ marginTop: 0 }}>По отделу</h2>
        <div className="stat-grid">
          <div className="stat"><div className="num">{d.issues}</div><div className="label">Замечаний</div></div>
          <div className="stat"><div className="num">{d.open}</div><div className="label">Открыто</div></div>
          <div className={`stat ${d.urgent > 0 ? 'stat-alert' : ''}`}><div className="num">{d.urgent}</div><div className="label">ОЧЕНЬ СРОЧНО</div></div>
          <div className="stat"><div className="num" style={{ color: 'var(--green,#16a34a)' }}>{d.praise}</div><div className="label">Похвалы</div></div>
          <div className="stat"><div className="num">{d.checkedBySona}</div><div className="label">Проверено (Сона)</div></div>
          <div className="stat"><div className="num">{d.checkedByMargarita}</div><div className="label">Проверено (Маргарита)</div></div>
        </div>
      </div>

      {urgent.length > 0 && (
        <>
          <h2 className="section-label" style={{ marginTop: 24, color: 'var(--red,#dc2626)' }}>
            🔴 ОЧЕНЬ СРОЧНО — {urgent.length}
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Проблема</th><th>Клиент</th><th>Бухгалтер</th><th>Дата</th><th>Чат</th></tr>
              </thead>
              <tbody>
                {urgent.map((p) => (
                  <tr key={p.problem_id} style={{ background: '#fff5f5' }}>
                    <td>{p.problem_title || '—'}</td>
                    <td>{p.client_name || '—'}</td>
                    <td>{p.accountant_name || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(p.detected_at)}</td>
                    <td>{p.chat_link ? <a href={p.chat_link} target="_blank" rel="noreferrer">→ чат</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
                <th>Открыто</th>
                <th>ОЧЕНЬ СРОЧНО</th>
                <th>Похвалы</th>
                <th>Провер. (Сона)</th>
                <th>Провер. (Марг.)</th>
                <th>Баланс</th>
              </tr>
            </thead>
            <tbody>
              {report.byAccountant.map((r) => (
                <tr key={r.accountantName}>
                  <td><b>{r.accountantName}</b></td>
                  <td>{r.issues}</td>
                  <td>{r.open > 0 ? <span className="badge badge-amber">{r.open}</span> : <span className="badge badge-green">0</span>}</td>
                  <td>{r.urgent > 0 ? <span className="badge badge-red">{r.urgent}</span> : 0}</td>
                  <td style={{ color: 'var(--green,#16a34a)' }}>{r.praise}</td>
                  <td>{r.checkedBySona}</td>
                  <td>{r.checkedByMargarita}</td>
                  <td style={{ color: r.balance < 0 ? 'var(--red,#dc2626)' : 'var(--green,#16a34a)', fontWeight: 600 }}>
                    {r.balance > 0 ? `+${r.balance}` : r.balance}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="section-label" style={{ marginTop: 24 }}>Предпросмотр отчёта для Telegram (ОК)</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Так выглядит сообщение, которое автоматически отправляется в группу ОК
        ежедневно (вечером) и еженедельно. Настройка отправки — в{' '}
        <code>supabase/functions/quality-report-telegram</code>.
      </p>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          background: 'var(--bg-soft,#f8f8f8)',
          padding: 14,
          borderRadius: 8,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {telegram.replace(/<\/?b>/g, '')}
      </pre>
    </>
  )
}

// ---- Sona work report («Объём работы Соны») --------------------------------
function SonaReport({ report }) {
  return (
    <>
      <div className="card" style={{ marginTop: 8 }}>
        <h2 className="section-label" style={{ marginTop: 0 }}>Объём работы Соны</h2>
        <div className="stat-grid">
          <div className="stat"><div className="num">{report.companiesChecked}</div><div className="label">Проверено компаний</div></div>
          <div className="stat"><div className="num">{report.reviews}</div><div className="label">Всего проверок</div></div>
          <div className="stat"><div className="num">{report.problems}</div><div className="label">С замечаниями</div></div>
          <div className="stat"><div className="num" style={{ color: 'var(--green,#16a34a)' }}>{report.clean}</div><div className="label">Без замечаний</div></div>
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
                <th>Проверено компаний</th>
                <th>С замечаниями</th>
                <th>Без замечаний</th>
                <th>Ср. оценка</th>
              </tr>
            </thead>
            <tbody>
              {report.byAccountant.map((r) => (
                <tr key={r.accountantName}>
                  <td><b>{r.accountantName}</b></td>
                  <td>{r.companiesChecked}</td>
                  <td>{r.problems}</td>
                  <td style={{ color: 'var(--green,#16a34a)' }}>{r.clean}</td>
                  <td>{r.avgScore ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="section-label" style={{ marginTop: 24 }}>По датам</h2>
      {report.checksByDay.length === 0 ? (
        <Empty text="Нет данных." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Дата</th><th>Проверено компаний</th></tr>
            </thead>
            <tbody>
              {report.checksByDay.map((d) => (
                <tr key={d.date}><td>{formatDate(d.date)}</td><td>{d.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
