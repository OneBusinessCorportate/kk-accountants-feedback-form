import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTasks, createTask, setTaskStatus, postponeTask, deleteTask, fetchAccountants } from '../lib/api'
import {
  TASK_TYPES,
  TASK_TYPE_LABELS,
  TASK_TYPE_BADGE,
  TASK_STATUS,
  TASK_STATUS_LABELS,
  TASK_OPEN_STATUSES,
  PRIORITY_LABELS,
} from '../lib/constants'
import { buildTaskMessage, TASK_PROGRESS, taskStatusOf } from '../lib/taskMessage'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'
import DbComparison from '../components/DbComparison'
import DailyAnalysis from '../components/DailyAnalysis'
import { useArtyomData } from '../lib/useArtyomData'

function today() {
  return new Date().toISOString().slice(0, 10)
}

// A task still needs work unless it's done or cancelled.
function isOpen(task) {
  return TASK_OPEN_STATUSES.includes(task.status || (task.done ? 'done' : 'open'))
}

// The date that actually applies — a postponed date overrides the original.
function effectiveDue(task) {
  return task.due_date_postponed || task.due_date || null
}

function isPastDue(task) {
  const due = effectiveDue(task)
  return isOpen(task) && !!due && due < today()
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}

function groupByAccountant(tasks) {
  const map = new Map()
  for (const t of tasks) {
    const key = t.accountant_name || '— Не назначено —'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(t)
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }))
}

const BLANK = { task_type: 'mailing', client_name: '', accountant_id: '', accountant_name: '', due_date: '', priority: 2, notes: '' }

export default function Tasks() {
  const { access, isSupervisor } = useAuth()
  const [tasks, setTasks] = useState([])
  const [accountants, setAccountants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filterType, setFilterType] = useState('')
  const [filterAccountant, setFilterAccountant] = useState('')
  // Show completed tasks by default so marking one done doesn't make it vanish
  // from the list (the toggle can still hide them).
  const [showDone, setShowDone] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    const filters = isSupervisor
      ? {}
      : { mine: { accountantId: access?.employee_id, createdBy: access?.full_name } }
    Promise.all([fetchTasks(filters), isSupervisor ? fetchAccountants() : Promise.resolve([])])
      .then(([t, a]) => { setTasks(t); setAccountants(a) })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [access, isSupervisor])

  useEffect(() => { load() }, [load])

  // ArmSoft/TaxService reference data for the per-task «сравнение с базой».
  const db = useArtyomData({ windowDays: 30 })

  function openForm() {
    const pre = isSupervisor
      ? BLANK
      : { ...BLANK, accountant_id: access?.employee_id || '', accountant_name: access?.full_name || '' }
    setForm(pre)
    setSaveError(null)
    setShowForm(true)
  }

  let visible = tasks
  if (filterType) visible = visible.filter((t) => t.task_type === filterType)
  if (filterAccountant) visible = visible.filter((t) => t.accountant_id === filterAccountant)
  if (!showDone) visible = visible.filter((t) => isOpen(t))

  const groups =
    isSupervisor && !filterAccountant
      ? groupByAccountant(visible)
      : [{ name: null, items: visible }]

  const pendingCount = tasks.filter((t) => isOpen(t)).length
  const overdueCount = tasks.filter((t) => isPastDue(t)).length

  // Auto-generated «Задачи:» message (req 3). Includes EVERY task — done (🟢),
  // in process (⭕) and not done (🔴) — regardless of the «показать выполненные»
  // toggle, so marking a task done never removes it from the message. Respects
  // only the type / accountant filters, and updates the moment a status changes.
  const message = useMemo(() => {
    let list = tasks
    if (filterType) list = list.filter((t) => t.task_type === filterType)
    if (filterAccountant) list = list.filter((t) => t.accountant_id === filterAccountant)
    return buildTaskMessage(list)
  }, [tasks, filterType, filterAccountant])

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (permissions / non-secure context) — the
      // textarea is still selectable, so this is a best-effort convenience.
    }
  }

  async function handleStatus(task, status) {
    try {
      // Postponing needs a new date; ask for it and keep the original due date.
      if (status === TASK_STATUS.postponed) {
        const date = window.prompt(
          'Новый срок (ГГГГ-ММ-ДД):',
          effectiveDue(task) || today(),
        )
        if (date === null) return
        const updated = await postponeTask(task.id, date.trim() || null)
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
        return
      }
      const updated = await setTaskStatus(task.id, status, access?.full_name)
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (e) {
      alert(e.message)
    }
  }

  async function handleDelete(task) {
    if (!window.confirm('Удалить задачу?')) return
    try {
      await deleteTask(task.id)
      setTasks((prev) => prev.filter((t) => t.id !== task.id))
    } catch (e) {
      alert(e.message)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    try {
      const client = form.client_name.trim()
      const created = await createTask({
        task_type: form.task_type,
        title: client
          ? `${TASK_TYPE_LABELS[form.task_type]} — ${client}`
          : TASK_TYPE_LABELS[form.task_type],
        client_name: client || null,
        accountant_id: form.accountant_id || null,
        accountant_name: form.accountant_name.trim() || null,
        due_date: form.due_date || null,
        priority: Number(form.priority) || 2,
        status: 'open',
        notes: form.notes.trim() || null,
        created_by: access?.full_name || null,
      })
      setTasks((prev) => [created, ...prev])
      setForm(BLANK)
      setShowForm(false)
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function handleAccSelect(e) {
    const id = e.target.value
    const acc = accountants.find((a) => a.id === id)
    setForm((f) => ({ ...f, accountant_id: id, accountant_name: acc?.name || '' }))
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <h1 className="page-title" style={{ margin: 0 }}>Системные задачи бухгалтеров</h1>
        <button className="btn" onClick={showForm ? () => setShowForm(false) : openForm}>
          {showForm ? 'Отмена' : '+ Задача'}
        </button>
      </div>
      <p className="page-subtitle">
        Задачи для бухгалтеров: рассылки, отчёты, квитанции, аудит и follow-up по
        результатам QA. Отдельно от апелляций.
      </p>

      {/* Full daily analysis from Supabase (ArmSoft + TaxService), show/hide. */}
      <DailyAnalysis />

      {/* Summary badges */}
      {pendingCount > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <span className="badge badge-blue">{pendingCount} открытых</span>
          {overdueCount > 0 && <span className="badge badge-red">{overdueCount} просрочено</span>}
        </div>
      )}

      {/* Inline add form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <div className="field">
                <label>Тип <span className="required-star">*</span></label>
                <select value={form.task_type} onChange={(e) => setForm((f) => ({ ...f, task_type: e.target.value }))}>
                  {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABELS[t]}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Клиент</label>
                <input
                  placeholder="Имя клиента"
                  value={form.client_name}
                  onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))}
                />
              </div>
              {isSupervisor && (
                <div className="field">
                  <label>Бухгалтер</label>
                  <select value={form.accountant_id} onChange={handleAccSelect}>
                    <option value="">— не назначен —</option>
                    {accountants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>Приоритет</label>
                <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                  {Object.entries(PRIORITY_LABELS).map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Срок</label>
                <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
              </div>
            </div>
            <div className="field">
              <label>Заметка</label>
              <input
                placeholder="Необязательно..."
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            {saveError && <div className="alert">{saveError}</div>}
            <div className="btn-row">
              <button className="btn" type="submit" disabled={saving}>{saving ? 'Сохраняю...' : 'Создать'}</button>
              <button className="btn btn-secondary" type="button" onClick={() => setShowForm(false)}>Отмена</button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="toolbar" style={{ marginBottom: 16 }}>
        <div className="field" style={{ marginBottom: 0, minWidth: 160 }}>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="">Все типы</option>
            {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        {isSupervisor && (
          <div className="field" style={{ marginBottom: 0, minWidth: 180 }}>
            <select value={filterAccountant} onChange={(e) => setFilterAccountant(e.target.value)}>
              <option value="">Все бухгалтеры</option>
              {accountants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 400, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Показать выполненные
        </label>
      </div>

      {/* Auto-generated message from task statuses (req 3). Updates live as
          statuses change; one line per visible task with 🟢 / ⭕ / 🔴. */}
      {message && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div className="section-label" style={{ margin: 0 }}>Сообщение по задачам</div>
            <button className="btn btn-secondary btn-sm" onClick={copyMessage}>
              {copied ? 'Скопировано ✓' : 'Копировать'}
            </button>
          </div>
          <textarea
            readOnly
            value={message}
            onFocus={(e) => e.target.select()}
            rows={Math.min(12, message.split('\n').length)}
            style={{
              width: '100%',
              fontFamily: 'inherit',
              fontSize: 14,
              lineHeight: 1.6,
              resize: 'vertical',
              padding: 8,
            }}
          />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            🟢 выполнено · ⭕ в процессе · 🔴 не выполнено
          </div>
        </div>
      )}

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <div className="empty">
          {tasks.length === 0 ? 'Задач нет — нажмите «+ Задача»' : 'Нет задач по фильтру'}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.name || '_all'} style={{ marginBottom: 24 }}>
            {g.name && (
              <div className="section-label">{g.name}</div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>Статус</th>
                    <th>Тип</th>
                    <th>Приоритет</th>
                    <th>Клиент</th>
                    {isSupervisor && !filterAccountant && <th>Бухгалтер</th>}
                    <th>Срок</th>
                    <th>Заметка</th>
                    <th>Создано</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((task) => {
                    const closed = task.done || task.status === 'cancelled'
                    const due = effectiveDue(task)
                    const cols = 8 + (isSupervisor && !filterAccountant ? 1 : 0)
                    return (
                    <Fragment key={task.id}>
                    <tr style={{ opacity: closed ? 0.5 : 1 }}>
                      <td>
                        {/* Clear three-state control (req 2): 🟢 done · ⭕ in
                            process · 🔴 not done. The dropdown below keeps the
                            full lifecycle (отложить / отменить). */}
                        <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
                          {TASK_PROGRESS.map((p) => {
                            const on = taskStatusOf(task) === p.status
                            return (
                              <button
                                key={p.status}
                                className="btn btn-sm"
                                onClick={() => handleStatus(task, p.status)}
                                title={p.label}
                                style={{
                                  padding: '2px 6px',
                                  lineHeight: 1.1,
                                  opacity: on ? 1 : 0.35,
                                  border: on ? '2px solid var(--accent, #2563eb)' : '1px solid var(--border, #ddd)',
                                  background: on ? 'var(--bg, #fff)' : 'transparent',
                                }}
                              >
                                {p.emoji}
                              </button>
                            )
                          })}
                        </div>
                        <select
                          value={task.status || (task.done ? TASK_STATUS.done : TASK_STATUS.open)}
                          onChange={(e) => handleStatus(task, e.target.value)}
                          style={{ padding: '2px 4px' }}
                        >
                          {Object.values(TASK_STATUS).map((s) => (
                            <option key={s} value={s}>
                              {TASK_STATUS_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={`badge ${TASK_TYPE_BADGE[task.task_type] || 'badge-gray'}`}>
                          {TASK_TYPE_LABELS[task.task_type] || task.task_type}
                        </span>
                        {task.problem_id && (
                          <>
                            {' '}
                            {task.chat_link ? (
                              <a href={task.chat_link} target="_blank" rel="noreferrer" title="Источник — проблема QA">
                                QA↗
                              </a>
                            ) : (
                              <span className="hint" title="Создана из проблемы QA">QA</span>
                            )}
                          </>
                        )}
                      </td>
                      <td>{PRIORITY_LABELS[task.priority] || PRIORITY_LABELS[2]}</td>
                      <td style={{ maxWidth: 200, whiteSpace: 'normal' }}>
                        <span style={closed ? { textDecoration: 'line-through' } : {}}>
                          {task.client_name || <span style={{ color: 'var(--muted)' }}>—</span>}
                        </span>
                      </td>
                      {isSupervisor && !filterAccountant && (
                        <td>{task.accountant_name || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                      )}
                      <td>
                        {due ? (
                          <span style={{ color: isPastDue(task) ? 'var(--red)' : 'inherit', fontWeight: isPastDue(task) ? 600 : 400 }}>
                            {fmtDate(due)}
                            {task.due_date_postponed && (
                              <span className="hint" title={`Изначально: ${fmtDate(task.due_date)}`}> (отложено)</span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ color: 'var(--muted)', maxWidth: 180, whiteSpace: 'normal' }}>
                        {task.notes || ''}
                      </td>
                      <td style={{ color: 'var(--muted)' }}>
                        {task.created_at ? fmtDate(task.created_at.slice(0, 10)) : '—'}
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleDelete(task)}
                          title="Удалить"
                          style={{ color: 'var(--red)', padding: '3px 8px' }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                    <tr style={{ opacity: closed ? 0.5 : 1 }}>
                      <td colSpan={cols} style={{ paddingTop: 0 }}>
                        <DbComparison
                          companies={db.companies}
                          activities={db.activities}
                          from={db.from}
                          to={db.to}
                          ready={db.ready}
                          loading={db.loading}
                          clientName={task.client_name}
                          accountantName={task.accountant_name}
                          taskType={task.task_type}
                        />
                      </td>
                    </tr>
                    </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
