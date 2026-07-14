import { useEffect, useState } from 'react'
import { fetchProblems } from '../lib/api'
import { groupSonaMarks, summarizeSonaMarks, SONA_SOURCE } from '../lib/sonaMarks'
import { formatDate } from '../lib/presentation'
import StatusBadge from '../components/StatusBadge'
import PriorityBadge from '../components/PriorityBadge'
import { Loading, ErrorMessage, Empty } from '../components/States'

// Management-only overview of Sona's marks about accountants. Every remark from
// Sona's accounting-quality review (source `sona_review`) is grouped under the
// accountant it was given to; hovering (or focusing) the ⓘ button next to a mark
// reveals the detail of the mistake behind it.
export default function SonaMarks() {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let ignore = false
    setLoading(true)
    setError(null)
    fetchProblems({ source: SONA_SOURCE })
      .then((rows) => !ignore && setGroups(groupSonaMarks(rows)))
      .catch((e) => !ignore && setError(e))
      .finally(() => !ignore && setLoading(false))
    return () => {
      ignore = true
    }
  }, [])

  const totals = summarizeSonaMarks(groups)

  return (
    <div>
      <h1 className="page-title">Оценки Соны</h1>
      <p className="page-subtitle">
        Замечания Соны по качеству бухгалтерской работы, сгруппированные по
        бухгалтерам. Наведите на кнопку ⓘ, чтобы увидеть, в чём заключалась ошибка.
      </p>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : groups.length === 0 ? (
        <Empty text="У Соны пока нет замечаний." />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="num">{totals.accountants}</div>
              <div className="label">Бухгалтеров с замечаниями</div>
            </div>
            <div className="stat">
              <div className="num">{totals.active}</div>
              <div className="label">Активных замечаний</div>
            </div>
            <div className="stat">
              <div className="num">{totals.total}</div>
              <div className="label">Всего замечаний</div>
            </div>
          </div>

          {groups.map((group) => (
            <AccountantMarks key={group.accountantId || group.accountantName} group={group} />
          ))}
        </>
      )}
    </div>
  )
}

function AccountantMarks({ group }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{group.accountantName}</h3>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="badge badge-amber">Активных: {group.active}</span>
          <span className="badge badge-gray">Всего: {group.total}</span>
        </span>
      </div>

      <ul className="mark-list">
        {group.marks.map((mark) => (
          <li key={mark.problem_id} className={`mark-row${mark.dismissed ? ' mark-dismissed' : ''}`}>
            <InfoButton info={mark.info} />
            <div className="mark-body">
              <div className="mark-title">
                {mark.priority != null && <PriorityBadge priority={mark.priority} />}
                <span>{mark.title}</span>
                {mark.dismissed && <span className="badge badge-gray">Снято</span>}
              </div>
              <div className="meta">
                {mark.client_name && (
                  <span>
                    Клиент: <b>{mark.client_name}</b>
                    {mark.contract_id && <span className="contract-id"> {mark.contract_id}</span>}
                  </span>
                )}
                {mark.detected_at && (
                  <span>
                    Дата: <b>{formatDate(mark.detected_at)}</b>
                  </span>
                )}
                {mark.chat_link && (
                  <span>
                    <a href={mark.chat_link} target="_blank" rel="noreferrer">
                      Открыть чат{mark.chat_name ? ` (${mark.chat_name})` : ''} ↗
                    </a>
                  </span>
                )}
                <StatusBadge status={mark.status} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// The ⓘ button. The mistake detail shows on hover AND on keyboard focus, so it
// works with a mouse, the keyboard and touch. aria-label carries the text for
// screen readers; the visible popover is aria-hidden to avoid a double read.
function InfoButton({ info }) {
  return (
    <span className="info">
      <button
        type="button"
        className="info-btn"
        aria-label={`Подробнее об ошибке: ${info}`}
      >
        i
      </button>
      <span className="info-tip" role="tooltip" aria-hidden="true">
        {info}
      </span>
    </span>
  )
}
