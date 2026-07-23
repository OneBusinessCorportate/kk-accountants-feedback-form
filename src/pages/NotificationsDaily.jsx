import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchPlannedNotifications,
  fetchNotificationAttachments,
  cancelPlannedNotification,
} from '../lib/api'
import { Loading, ErrorMessage, Empty } from '../components/States'
import { formatDate } from '../lib/dashboard'
import {
  groupByDay,
  sendableCount,
  categoryLabel,
  statusLabel,
  statusBadge,
  attachmentKey,
  willActuallySend,
} from '../lib/notifications'

/**
 * «Рассылки (по дням)» — management daily overview (pt.5). Groups ALL planned
 * client notifications by the day they will be sent, so supervisors can review
 * everything going out on a given day and intervene (cancel) before the bot
 * sends. Management-only route.
 */
export default function NotificationsDaily() {
  const [planned, setPlanned] = useState([])
  const [attachments, setAttachments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(
    () =>
      Promise.all([fetchPlannedNotifications(), fetchNotificationAttachments()]).then(
        ([p, a]) => {
          setPlanned(p || [])
          setAttachments(a || [])
        },
      ),
    [],
  )

  useEffect(() => {
    let alive = true
    setLoading(true)
    load()
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [load])

  const days = useMemo(() => groupByDay(planned), [planned])
  const attByKey = useMemo(
    () => new Map((attachments || []).map((a) => [`${a.agr_no}|${a.period}|${a.category}`, a])),
    [attachments],
  )

  const cancel = async (id) => {
    try {
      await cancelPlannedNotification({ plannedId: id })
      await load()
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(e.message || String(e))
    }
  }

  if (loading) return <Loading />
  if (error) return <ErrorMessage error={error} />

  return (
    <div>
      <h1 className="page-title" style={{ margin: 0 }}>
        Рассылки по дням
      </h1>
      <p className="page-subtitle">
        Все запланированные уведомления клиентам, сгруппированные по дню отправки.
        Здесь можно проверить, что уйдёт сегодня, и вмешаться (отменить) до
        отправки ботом.
      </p>

      {days.length === 0 ? (
        <Empty text="Запланированных уведомлений нет." />
      ) : (
        days.map((day) => (
          <div key={day.date} style={{ marginBottom: '1.25rem' }}>
            <h2 style={{ marginBottom: 6 }}>
              {formatDate(day.date)}
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>
                будет отправлено: {sendableCount(day.rows, attByKey)} из {day.rows.length}
              </span>
            </h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Договор</th>
                    <th>Категория</th>
                    <th>Статус</th>
                    <th>Текст</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {day.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.agr_no}</td>
                      <td>{categoryLabel(r.category)}</td>
                      <td>
                        <span className={`badge ${statusBadge(r.status)}`}>{statusLabel(r.status)}</span>
                        {r.status !== 'sent' &&
                          r.status !== 'cancelled' &&
                          !willActuallySend(r, attByKey.get(attachmentKey(r))) && (
                            <span className="badge badge-amber" style={{ marginLeft: 6 }}>
                              нужен документ
                            </span>
                          )}
                      </td>
                      <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{r.rendered_text}</td>
                      <td>
                        {r.status !== 'sent' && r.status !== 'cancelled' && (
                          <button className="btn btn-secondary btn-sm" onClick={() => cancel(r.id)}>
                            Отменить
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
