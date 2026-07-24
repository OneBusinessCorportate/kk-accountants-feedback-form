import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchChats,
  fetchPlannedNotifications,
  fetchNotificationAttachments,
  fetchSentNotifications,
  editPlannedNotification,
  attachNotification,
} from '../lib/api'
import { Loading, ErrorMessage, Empty } from '../components/States'
import { formatDate } from '../lib/dashboard'
import {
  WILL_SEND_WARNING,
  categoryLabel,
  modeLabel,
  statusLabel,
  statusBadge,
  needsAttachment,
  willActuallySend,
  isTerminal,
} from '../lib/notifications'

// One planned-notification row with inline edit + actions.
function PlannedRow({ row, attachment, canAct, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(row.rendered_text || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const held = needsAttachment(row, attachment)
  // Only warn "WILL be sent" when the bot will truly send it — a manual row
  // still missing its document is held, not going out.
  const willSend = willActuallySend(row, attachment)

  // Returns true on success, false on failure — callers use it so the editor is
  // closed only when the save actually succeeded.
  const run = async (fn) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await onChanged()
      return true
    } catch (e) {
      setErr(e.message || String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ padding: '0.9rem', marginBottom: '0.6rem' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{categoryLabel(row.category)}</strong>
        <span className={`badge ${row.mode === 'auto' ? 'badge-blue' : 'badge-amber'}`}>
          {modeLabel(row.mode)}
        </span>
        <span className={`badge ${statusBadge(row.status)}`}>{statusLabel(row.status)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
          Отправка: {formatDate(row.scheduled_date)}
        </span>
      </div>

      {willSend && (
        <div className="badge badge-amber" style={{ marginTop: 6, whiteSpace: 'normal', lineHeight: 1.4 }}>
          ⚠️ {WILL_SEND_WARNING}
        </div>
      )}
      {held && (
        <div className="badge badge-red" style={{ marginTop: 6, whiteSpace: 'normal', lineHeight: 1.4 }}>
          Нужен документ: приложите файл (или отметьте «сделано») — иначе бот не отправит это ручное уведомление.
        </div>
      )}

      {editing ? (
        <div style={{ marginTop: 8 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: 'inherit' }}
          />
        </div>
      ) : (
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'inherit',
            margin: '8px 0 0',
            fontSize: '0.92rem',
          }}
        >
          {row.rendered_text}
        </pre>
      )}
      {row.accompanying_text && !editing && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          Сопроводительный текст: {row.accompanying_text}
        </div>
      )}

      {err && <div className="badge badge-red" style={{ marginTop: 6 }}>{err}</div>}

      {canAct && !isTerminal(row.status) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {editing ? (
            <>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  run(() => editPlannedNotification({ plannedId: row.id, newText: text })).then(
                    (okSaved) => {
                      if (okSaved) setEditing(false)
                    },
                  )
                }
              >
                Сохранить
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => {
                  setText(row.rendered_text || '')
                  setEditing(false)
                }}
              >
                Отмена
              </button>
            </>
          ) : (
            // The bot always sends this at its scheduled time — the only action
            // is editing the text (allowed any time before it is sent).
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>
              Редактировать текст
            </button>
          )}
        </div>
      )}

      {canAct && row.mode === 'manual' && !isTerminal(row.status) && (
        <ManualAttach row={row} attachment={attachment} onChanged={onChanged} />
      )}
    </div>
  )
}

// Manual-input section (pt.2): attach a file by month or mark done + optional text.
function ManualAttach({ row, attachment, onChanged }) {
  const [fileName, setFileName] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const submit = async (markedDone) => {
    setBusy(true)
    setErr(null)
    try {
      await attachNotification({
        agrNo: row.agr_no,
        period: row.period,
        category: row.category,
        fileUrl: fileUrl.trim() || null,
        fileName: fileName.trim() || null,
        markedDone,
        accompanyingText: note.trim() || null,
      })
      setFileName('')
      setFileUrl('')
      setNote('')
      await onChanged()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #eee)', paddingTop: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
        Ручной документ ({categoryLabel(row.category)}) за период {row.period}
        {attachment?.file_url || attachment?.marked_done ? ' — приложено ✓' : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          placeholder="Название файла"
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          style={{ flex: '1 1 160px' }}
        />
        <input
          placeholder="Ссылка на файл (URL)"
          value={fileUrl}
          onChange={(e) => setFileUrl(e.target.value)}
          style={{ flex: '1 1 200px' }}
        />
      </div>
      <input
        placeholder="Сопроводительный текст (необязательно)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ width: '100%', marginTop: 6 }}
      />
      {err && <div className="badge badge-red" style={{ marginTop: 6 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" disabled={busy || !fileUrl.trim()} onClick={() => submit(false)}>
          Приложить файл
        </button>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => submit(true)}>
          Отметить «сделано»
        </button>
      </div>
    </div>
  )
}

function SentLog({ rows }) {
  const [open, setOpen] = useState(false)
  if (!rows?.length) return null
  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn btn-secondary btn-sm" onClick={() => setOpen((v) => !v)}>
        {open ? 'Скрыть' : 'Показать'} отправленные ({rows.length})
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {rows.map((s) => (
            <div key={s.id} className="card" style={{ padding: '0.6rem', marginBottom: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {formatDate(s.sent_date)} · {categoryLabel(s.category)} · {s.subtype}
                {s.telegram_ok ? '' : ' · ошибка отправки'}
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontFamily: 'inherit', fontSize: '0.88rem' }}>
                {s.full_text}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * «Уведомления» — the upcoming templated messages the bot will send to each of
 * the accountant's clients (plan → edit/attach → bot sends → log). The
 * accountant can edit the text, attach a monthly document / mark done, approve
 * or cancel; if they do nothing the bot sends on schedule. A read-only log of
 * everything already sent to each client is shown per company.
 */
export default function Notifications() {
  const [chats, setChats] = useState([])
  const [planned, setPlanned] = useState([])
  const [attachments, setAttachments] = useState([])
  const [sent, setSent] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    // Do NOT swallow errors here: an auth/DB failure must surface on the error
    // screen, not be shown to the accountant as "no notifications".
    const [c, p, a, s] = await Promise.all([
      fetchChats(),
      fetchPlannedNotifications(),
      fetchNotificationAttachments(),
      fetchSentNotifications(),
    ])
    setChats(c || [])
    setPlanned(p || [])
    setAttachments(a || [])
    setSent(s || [])
  }, [])

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

  const reload = useCallback(() => load(), [load])

  // The planned/attachment/sent reads are already scoped to the caller's own
  // companies server-side (kk_list_* RPCs), so we simply group what came back —
  // one section per company that has at least one planned notification.
  const companies = useMemo(() => {
    const chatBy = new Map((chats || []).map((c) => [c.agr_no, c]))
    const attByKey = new Map(
      (attachments || []).map((a) => [`${a.agr_no}|${a.period}|${a.category}`, a]),
    )
    const sentBy = new Map()
    for (const s of sent || []) {
      if (!sentBy.has(s.agr_no)) sentBy.set(s.agr_no, [])
      sentBy.get(s.agr_no).push(s)
    }
    const plannedByCompany = new Map()
    for (const row of planned || []) {
      if (!plannedByCompany.has(row.agr_no)) plannedByCompany.set(row.agr_no, [])
      plannedByCompany.get(row.agr_no).push(row)
    }
    // A company appears if it has upcoming planned messages OR any sent history
    // (so a client with only past sends still shows its read-only sent-log).
    const agrNos = new Set([...plannedByCompany.keys(), ...sentBy.keys()])
    return [...agrNos]
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map((agrNo) => ({
        agrNo,
        chat: chatBy.get(agrNo),
        rows: (plannedByCompany.get(agrNo) || [])
          .slice()
          .sort((x, y) => String(x.scheduled_date).localeCompare(String(y.scheduled_date))),
        attByKey,
        sent: sentBy.get(agrNo) || [],
      }))
  }, [chats, planned, attachments, sent])

  if (loading) return <Loading />
  if (error) return <ErrorMessage error={error} />

  return (
    <div>
      <h1 className="page-title" style={{ margin: 0 }}>
        Уведомления клиентам
      </h1>
      <p className="page-subtitle">
        Предстоящие сообщения, которые бот отправит вашим клиентам по расписанию.
        Отредактируйте текст, приложите документ или отмените отправку — если
        ничего не менять, бот отправит запланированное сообщение сам.
      </p>

      {companies.length === 0 ? (
        <Empty text="Запланированных уведомлений нет. План на 30 дней формируется автоматически ежедневно." />
      ) : (
        companies.map((co) => (
          <div key={co.agrNo} style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginBottom: 4 }}>
              {co.agrNo}
              <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>
                язык: {co.chat?.language || 'ru'}
              </span>
            </h2>
            {co.rows.map((row) => (
              <PlannedRow
                key={row.id}
                row={row}
                attachment={co.attByKey.get(`${row.agr_no}|${row.period}|${row.category}`)}
                canAct
                onChanged={reload}
              />
            ))}
            <SentLog rows={co.sent} />
          </div>
        ))
      )}
    </div>
  )
}
