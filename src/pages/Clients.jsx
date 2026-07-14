import React, { useEffect, useMemo, useState } from 'react'
import { fetchProblems, fetchChats, fetchTasks, fetchMailings, createTask } from '../lib/api'
import { TASK_TYPE_LABELS, SOURCE_LABELS } from '../lib/constants'
import {
  DASHBOARD_SOURCES,
  prepareDashboard,
  groupClients,
  formatDate,
  buildMailingIndex,
  mailingStateForContracts,
} from '../lib/dashboard'
import { keepOwnProblems } from '../lib/scope'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'

// Columns shown as checkmark cells — the "Maggie's file" columns
const CHECK_TYPES = ['mailing', 'report', 'receipt']

// Predefined task titles offered directly in the table (req 1). Picking one
// creates a task with that exact name; «Другое» opens a free-text input.
const PRESET_TASKS = ['հաշիվ գրել', 'փոխանցում անել']
const OTHER_OPTION = '__other__'

const RESOLVED = new Set(['fixed', 'explained_accepted'])

export default function Clients() {
  const { access, isSupervisor } = useAuth()
  const [problems, setProblems] = useState([])
  const [chats, setChats] = useState([])
  const [tasks, setTasks] = useState([])
  const [mailings, setMailings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [onlyNoMailing, setOnlyNoMailing] = useState(false)
  const [creating, setCreating] = useState(null)
  // Free-text «Другое» task input: which client's input is open + its text.
  const [otherFor, setOtherFor] = useState(null)
  const [otherText, setOtherText] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      fetchProblems({ sourceIn: DASHBOARD_SOURCES }),
      fetchChats().catch(() => []),
      fetchTasks(),
      fetchMailings().catch(() => []),
    ])
      .then(([p, c, t, m]) => {
        if (!active) return
        setProblems(keepOwnProblems(p, access))
        setChats(c)
        setTasks(t)
        setMailings(m)
      })
      .catch(setError)
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [access])

  // Active chats only, deduped, AI-free — then one row per client (req 4/8).
  const clients = useMemo(() => {
    const { active } = prepareDashboard({ problems, chats, period: 'all', now: new Date() })
    const taskByClient = new Map()
    for (const t of tasks) {
      if (!t.client_name) continue
      const key = t.client_name.trim().toLowerCase()
      if (!taskByClient.has(key)) taskByClient.set(key, [])
      taskByClient.get(key).push(t)
    }
    let list = groupClients(active).map((c) => ({
      ...c,
      tasks: taskByClient.get(c.key) || [],
    }))
    list.sort((a, b) => {
      const aOpen = a.problems.filter((p) => !RESOLVED.has(p.status)).length
      const bOpen = b.problems.filter((p) => !RESOLVED.has(p.status)).length
      return bOpen - aOpen || a.name.localeCompare(b.name)
    })
    return list
  }, [problems, chats, tasks])

  // Contract → mailing state, from Margarita's real mailing log (kk_chat_mailings).
  const mailingIndex = useMemo(() => buildMailingIndex(mailings), [mailings])

  function hasDone(client, type) {
    return client.tasks.some((t) => t.task_type === type && t.done)
  }
  function hasPending(client, type) {
    return client.tasks.some((t) => t.task_type === type && !t.done)
  }

  // The «Рассылка» status is derived from Margarita's real mailing records
  // (normalised), so a mailing that was actually done no longer shows as
  // not-done. A manually-completed kk_tasks mailing still counts as done.
  function mailingState(client) {
    if (hasDone(client, 'mailing')) return 'done'
    const st = mailingStateForContracts(client.contracts, mailingIndex)
    if (st !== 'none') return st
    if (hasPending(client, 'mailing')) return 'pending'
    return 'none'
  }

  const visibleClients = onlyNoMailing
    ? clients.filter((c) => mailingState(c) !== 'done')
    : clients

  async function handleQuickCreate(clientName, type) {
    const key = `${clientName}:${type}`
    setCreating(key)
    try {
      const created = await createTask({
        task_type: type,
        title: `${TASK_TYPE_LABELS[type]} — ${clientName}`,
        client_name: clientName,
        created_by: access?.full_name || null,
      })
      setTasks((prev) => [created, ...prev])
    } catch (e) {
      alert(e.message)
    } finally {
      setCreating(null)
    }
  }

  // The accountant a new task should be attributed to, so it shows up in that
  // person's «Задачи». Prefer the client's own resolved accountant; otherwise
  // the current user (regular accountants work their own clients), leaving it
  // unassigned only for supervisors with no owner on record.
  function taskAssignee(client) {
    const owned = client.problems.find((p) => p.accountant_id)
    if (owned) return { id: owned.accountant_id, name: owned.accountant_name || null }
    if (!isSupervisor) return { id: access?.employee_id || null, name: access?.full_name || null }
    return { id: null, name: null }
  }

  // Create a free-form named task for a client (req 1). The title IS the name
  // the user picked («հաշիվ գրել» / «փোখানցум անել» / their own text).
  async function createNamedTask(client, title) {
    const name = (title || '').trim()
    if (!name) return
    const key = `${client.name}:named`
    setCreating(key)
    try {
      const who = taskAssignee(client)
      const created = await createTask({
        task_type: 'other',
        title: name,
        client_name: client.name,
        accountant_id: who.id,
        accountant_name: who.name,
        status: 'open',
        created_by: access?.full_name || null,
      })
      setTasks((prev) => [created, ...prev])
    } catch (e) {
      alert(e.message)
    } finally {
      setCreating(null)
    }
  }

  function handlePickTask(client, value) {
    if (!value) return
    if (value === OTHER_OPTION) {
      setOtherText('')
      setOtherFor(client.key)
      return
    }
    createNamedTask(client, value)
  }

  async function submitOther(client) {
    const text = otherText.trim()
    if (!text) return
    await createNamedTask(client, text)
    setOtherFor(null)
    setOtherText('')
  }

  function taskCell(client, type) {
    const key = `${client.name}:${type}`
    const busy = creating === key
    // Mailing status comes from Margarita's records (with a manual override);
    // report/receipt stay on the manual kk_tasks check.
    const done = type === 'mailing' ? mailingState(client) === 'done' : hasDone(client, type)
    const pending = type === 'mailing' ? mailingState(client) === 'pending' : hasPending(client, type)
    if (done)
      return <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 16 }}>✓</span>
    if (pending)
      return <span style={{ color: 'var(--amber)', fontSize: 16 }}>○</span>
    return (
      <button
        className="btn btn-secondary btn-sm"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          handleQuickCreate(client.name, type)
        }}
        title={`Создать: ${TASK_TYPE_LABELS[type]}`}
        style={{ padding: '2px 8px', fontSize: 13, color: 'var(--muted)' }}
      >
        {busy ? '...' : '+'}
      </button>
    )
  }

  const missingMailingCount = clients.filter((c) => mailingState(c) !== 'done').length

  return (
    <div>
      <h1 className="page-title">Клиенты</h1>
      <p className="page-subtitle">
        Только активные чаты (kk-soprovozhdeniya) · один клиент — одна строка.
      </p>

      <ErrorMessage error={error} />
      {loading ? <Loading /> : null}

      {!loading && (
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginBottom: 16,
              flexWrap: 'wrap',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                fontWeight: 400,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={onlyNoMailing}
                onChange={(e) => setOnlyNoMailing(e.target.checked)}
              />
              Только без рассылки
              {missingMailingCount > 0 && (
                <span className="badge badge-amber" style={{ marginLeft: 4 }}>
                  {missingMailingCount}
                </span>
              )}
            </label>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              ✓ выполнено · ○ в работе · «+» нет задачи
            </span>
          </div>

          {visibleClients.length === 0 ? (
            <div className="empty">
              {onlyNoMailing ? 'Все клиенты получили рассылку' : 'Нет данных о клиентах'}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Проблем</th>
                    <th>Источники</th>
                    {CHECK_TYPES.map((t) => (
                      <th key={t} style={{ textAlign: 'center' }}>
                        {TASK_TYPE_LABELS[t]}
                      </th>
                    ))}
                    <th style={{ textAlign: 'center' }}>Задача</th>
                    <th>Проблемные чаты</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleClients.map((c) => {
                    const isExpanded = expanded === c.key
                    const openProblems = c.problems.filter((p) => !RESOLVED.has(p.status))
                    const noMailing = mailingState(c) !== 'done'
                    return (
                      <React.Fragment key={c.key}>
                        <tr
                          onClick={() => setExpanded(isExpanded ? null : c.key)}
                          style={{
                            cursor: 'pointer',
                            background:
                              noMailing && openProblems.length > 0 ? '#fffbf0' : undefined,
                          }}
                        >
                          <td style={{ fontWeight: 600 }}>{c.name}</td>
                          <td>
                            {openProblems.length > 0 ? (
                              <span style={{ color: 'var(--red)', fontWeight: 600 }}>
                                ⚠ {openProblems.length}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--green)' }}>✓ 0</span>
                            )}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {c.sources.map((s) => SOURCE_LABELS[s] || s).join(', ')}
                          </td>
                          {CHECK_TYPES.map((t) => (
                            <td key={t} style={{ textAlign: 'center' }}>
                              {taskCell(c, t)}
                            </td>
                          ))}
                          <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                            {otherFor === c.key ? (
                              <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                                <input
                                  autoFocus
                                  value={otherText}
                                  onChange={(e) => setOtherText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') submitOther(c)
                                    if (e.key === 'Escape') setOtherFor(null)
                                  }}
                                  placeholder="Название задачи"
                                  style={{ fontSize: 13, padding: '2px 6px', minWidth: 130 }}
                                />
                                <button
                                  className="btn btn-sm"
                                  disabled={creating === `${c.name}:named`}
                                  onClick={() => submitOther(c)}
                                  style={{ padding: '2px 8px' }}
                                >
                                  ОК
                                </button>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => setOtherFor(null)}
                                  style={{ padding: '2px 8px' }}
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <select
                                value=""
                                disabled={creating === `${c.name}:named`}
                                onChange={(e) => {
                                  handlePickTask(c, e.target.value)
                                  e.target.value = ''
                                }}
                                title="Добавить задачу"
                                style={{ fontSize: 13, padding: '2px 6px', color: 'var(--muted)' }}
                              >
                                <option value="">+ задача</option>
                                {PRESET_TASKS.map((t) => (
                                  <option key={t} value={t}>
                                    {t}
                                  </option>
                                ))}
                                <option value={OTHER_OPTION}>Другое…</option>
                              </select>
                            )}
                          </td>
                          <td>
                            {c.chats.slice(0, 3).map((ch) => (
                              <a
                                key={ch.link}
                                href={ch.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{ marginRight: 10, whiteSpace: 'nowrap' }}
                              >
                                {ch.name}
                              </a>
                            ))}
                            {c.chats.length > 3 && (
                              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                                +{c.chats.length - 3}
                              </span>
                            )}
                            {c.chats.length === 0 && <span style={{ color: 'var(--muted)' }}>—</span>}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td
                              colSpan={5 + CHECK_TYPES.length}
                              style={{ background: 'var(--bg)', padding: '10px 16px' }}
                            >
                              {c.problems.map((p) => (
                                <div
                                  key={p.problem_id}
                                  style={{
                                    display: 'flex',
                                    gap: 10,
                                    alignItems: 'baseline',
                                    marginBottom: 6,
                                    fontSize: 13,
                                  }}
                                >
                                  <span
                                    className={`badge ${
                                      RESOLVED.has(p.status) ? 'badge-green' : 'badge-amber'
                                    }`}
                                  >
                                    {RESOLVED.has(p.status) ? 'Решено' : 'Открыта'}
                                  </span>
                                  <span style={{ fontWeight: 500 }}>
                                    {p.problem_title || 'Проблема'}
                                  </span>
                                  {p.accountant_name && (
                                    <span style={{ color: 'var(--muted)' }}>{p.accountant_name}</span>
                                  )}
                                  <span style={{ color: 'var(--muted)' }}>
                                    {formatDate(p.detected_at)}
                                  </span>
                                  {p.chat_link && (
                                    <a href={p.chat_link} target="_blank" rel="noopener noreferrer">
                                      → чат
                                    </a>
                                  )}
                                </div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
