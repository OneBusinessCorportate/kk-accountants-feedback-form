import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchPlannedNotifications, fetchNotificationAttachments } from '../lib/api'
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
  isTerminal,
} from '../lib/notifications'

/**
 * «Рассылки (по дням)» — management daily overview (pt.5). Read-only: groups the
 * upcoming client notifications by the day the bot will send them, so
 * supervisors can review what is going out. Sending cannot be cancelled — the
 * bot always sends at the scheduled time; the accountant can only edit the text
 * beforehand (on the «Уведомления» page). Management-only route.
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

  if (loading) return <Loading />
  if (error) return <ErrorMessage error={error} />

  return (
    <div>
      <h1 className="page-title" style={{ margin: 0 }}>
        Рассылки по дням
      </h1>
      <p className="page-subtitle">
        Предстоящие уведомления клиентам, сгруппированные по дню отправки. Здесь
        можно заранее проверить, что уйдёт сегодня. Отменить отправку нельзя —
        бот отправляет по расписанию; текст правится на странице «Уведомления».
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
                  </tr>
                </thead>
                <tbody>
                  {day.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.agr_no}</td>
                      <td>{categoryLabel(r.category)}</td>
                      <td>
                        <span className={`badge ${statusBadge(r.status)}`}>{statusLabel(r.status)}</span>
                        {!isTerminal(r.status) &&
                          !willActuallySend(r, attByKey.get(attachmentKey(r))) && (
                            <span className="badge badge-amber" style={{ marginLeft: 6 }}>
                              нужен документ
                            </span>
                          )}
                      </td>
                      <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>{r.rendered_text}</td>
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
