import React, { useCallback, useEffect, useState } from 'react'
import { fetchTasks, createTask, completeTask, reopenTask, deleteTask, fetchAccountants } from '../lib/api'
import { TASK_TYPES, TASK_TYPE_LABELS, TASK_TYPE_BADGE } from '../lib/constants'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'

const EMPTY_FORM = {
  task_type: 'mailing',
  title: '',
  client_name: '',
  chat_link: '',
  accountant_id: '',
  accountant_name: '',
  due_date: '',
  notes: '',
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function isPastDue(task) {
  return !task.done && !!task.due_date && task.due_date < today()
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

export default function Tasks() {
  const { access, isSupervisor } = useAuth()
  const [tasks, setTasks] = useState([])
  const [accountants, setAccountants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filterType, setFilterType] = useState('')
  const [filterAccountant, setFilterAccountant] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    const filters = isSupervisor ? {} : { accountantId: access?.id }
    Promise.all([fetchTasks(filters), isSupervisor ? fetchAccountants() : Promise.resolve([])])
      .then(([t, a]) => {
        setTasks(t)
        setAccountants(a)
      })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [access, isSupervisor])

  useEffect(() => {
    load()
  }, [load])

  function openForm() {
    const pre = isSupervisor
      ? EMPTY_FORM
      : { ...EMPTY_FORM, accountant_id: access?.id || '', accountant_name: access?.full_name || '' }
    setForm(pre)
    setSaveError(null)
    setShowForm(true)
  }

  let visible = tasks
  if (filterType) visible = visible.filter((t) => t.task_type === filterType)
  if (filterAccountant) visible = visible.filter((t) => t.accountant_id === filterAccountant)
  if (!showDone) visible = visible.filter((t) => !t.done)

  const groups =
    isSupervisor && !filterAccountant
      ? groupByAccountant(visible)
      : [{ name: null, items: visible }]

  const pendingCount = tasks.filter((t) => !t.done).length
  const overdueCount = tasks.filter((t) => isPastDue(t)).length

  async function handleToggle(task) {
    try {
      const updated = task.done
        ? await reopenTask(task.id)
        : await completeTask(task.id, access?.full_name)
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
      const payload = {
        task_type: form.task_type,
        title: form.title.trim() || TASK_TYPE_LABELS[form.task_type],
        client_name: form.client_name.trim() || null,
        chat_link: form.chat_link.trim() || null,
        accountant_id: form.accountant_id || null,
        accountant_name: form.accountant_name.trim() || null,
        due_date: form.due_date || null,
        notes: form.notes.trim() || null,
        created_by: access?.full_name || null,
      }
      const created = await createTask(payload)
      setTasks((prev) => [created, ...prev])
      setForm(EMPTY_FORM)
      setShowForm(false)
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function handleAccSelect(e) {
    const id = e.target.value
    const acc = accountants.find((a) => a.id === id)
    setForm((f) => ({ ...f, accountant_id: id, accountant_name: acc?.name || '' }))
  }

  return (
    <div>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}
      >
        <h1 className="page-title" style={{ margin: 0 }}>
          Задачи
        </h1>
        <button className="btn" onClick={showForm ? () => setShowForm(false) : openForm}>
          {showForm ? 'Отмена' : '+ Задача'}
        </button>
      </div>
      <p className="page-subtitle">Рассылки, отчёты, квитанции, аудит — по клиентам и бухгалтерам.</p>

      {pendingCount > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <span className="badge badge-blue">{pendingCount} открытых</span>
          {overdueCount > 0 && (
            <span className="badge badge-red">{overdueCount} просрочено</span>
          )}
        </div>
      )}

      {showForm && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Новая задача</h3>
          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                gap: 12,
              }}
            >
              <div className="field">
                <label>
                  Тип <span className="required-star">*</span>
                </label>
                <select value={form.task_type} onChange={(e) => setField('task_type', e.target.value)}>
                  {TASK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TASK_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Клиент</label>
                <input
                  placeholder="Имя клиента"
                  value={form.client_name}
                  onChange={(e) => setField('client_name', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Название</label>
                <input
                  placeholder={TASK_TYPE_LABELS[form.task_type]}
                  value={form.title}
                  onChange={(e) => setField('title', e.target.value)}
                />
              </div>
              {isSupervisor && (
                <div className="field">
                  <label>Бухгалтер</label>
                  <select value={form.accountant_id} onChange={handleAccSelect}>
                    <option value="">— не назначен —</option>
                    {accountants.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label>Срок</label>
                <input
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setField('due_date', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Ссылка на чат</label>
                <input
                  placeholder="https://..."
                  value={form.chat_link}
                  onChange={(e) => setField('chat_link', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>Заметки</label>
              <textarea
                rows={2}
                placeholder="Дополнительно..."
                value={form.notes}
                onChange={(e) => setField('notes', e.target.value)}
              />
            </div>
            {saveError && <div className="alert">{saveError}</div>}
            <div className="btn-row">
              <button className="btn" type="submit" disabled={saving}>
                {saving ? 'Сохраняю...' : 'Создать'}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setShowForm(false)}
              >
                Отмена
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="toolbar" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            className={filterType === '' ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setFilterType('')}
          >
            Все
          </button>
          {TASK_TYPES.map((t) => (
            <button
              key={t}
              className={filterType === t ? 'btn btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setFilterType(filterType === t ? '' : t)}
            >
              {TASK_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        {isSupervisor && (
          <div className="field" style={{ marginBottom: 0, minWidth: 180 }}>
            <select
              value={filterAccountant}
              onChange={(e) => setFilterAccountant(e.target.value)}
            >
              <option value="">Все бухгалтеры</option>
              {accountants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontWeight: 400,
            whiteSpace: 'nowrap',
          }}
        >
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />
          Показать выполненные
        </label>
      </div>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <div className="empty">
          {tasks.length === 0 ? 'Задач пока нет — нажмите «+ Задача»' : 'Нет задач по фильтру'}
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.name || '_all'} style={{ marginBottom: 24 }}>
            {g.name && (
              <div
                style={{
                  margin: '0 0 8px',
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {g.name}
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Тип</th>
                    <th>Задача</th>
                    <th>Клиент</th>
                    {isSupervisor && !filterAccountant && <th>Бухгалтер</th>}
                    <th>Срок</th>
                    <th>Чат</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((task) => (
                    <tr key={task.id} style={{ opacity: task.done ? 0.45 : 1 }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={task.done}
                          onChange={() => handleToggle(task)}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                        />
                      </td>
                      <td>
                        <span className={`badge ${TASK_TYPE_BADGE[task.task_type] || 'badge-gray'}`}>
                          {TASK_TYPE_LABELS[task.task_type] || task.task_type}
                        </span>
                      </td>
                      <td style={{ maxWidth: 220, whiteSpace: 'normal' }}>
                        <span style={task.done ? { textDecoration: 'line-through' } : {}}>
                          {task.title}
                        </span>
                        {task.notes && (
                          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
                            {task.notes}
                          </div>
                        )}
                      </td>
                      <td>{task.client_name || '—'}</td>
                      {isSupervisor && !filterAccountant && (
                        <td>{task.accountant_name || '—'}</td>
                      )}
                      <td>
                        {task.due_date ? (
                          <span style={{ color: isPastDue(task) ? 'var(--red)' : 'inherit', fontWeight: isPastDue(task) ? 600 : 400 }}>
                            {fmtDate(task.due_date)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {task.chat_link ? (
                          <a href={task.chat_link} target="_blank" rel="noopener noreferrer">
                            Открыть
                          </a>
                        ) : (
                          '—'
                        )}
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
