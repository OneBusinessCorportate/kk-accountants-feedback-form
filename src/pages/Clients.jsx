import React, { useEffect, useMemo, useState } from 'react'
import { fetchProblems, fetchChats, fetchTasks, createTask } from '../lib/api'
import { TASK_TYPE_LABELS, SOURCE_LABELS } from '../lib/constants'
import { DASHBOARD_SOURCES, prepareDashboard, groupClients, formatDate } from '../lib/dashboard'
import { keepOwnProblems } from '../lib/scope'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'

// Columns shown as checkmark cells — the "Maggie's file" columns
const CHECK_TYPES = ['mailing', 'report', 'receipt']

const RESOLVED = new Set(['fixed', 'explained_accepted'])

export default function Clients() {
  const { access } = useAuth()
  const [problems, setProblems] = useState([])
  const [chats, setChats] = useState([])
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [onlyNoMailing, setOnlyNoMailing] = useState(false)
  const [creating, setCreating] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      fetchProblems({ sourceIn: DASHBOARD_SOURCES }),
      fetchChats().catch(() => []),
      fetchTasks(),
    ])
      .then(([p, c, t]) => {
        if (!active) return
        setProblems(keepOwnProblems(p, access))
        setChats(c)
        setTasks(t)
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

  const visibleClients = onlyNoMailing
    ? clients.filter((c) => !c.tasks.some((t) => t.task_type === 'mailing' && t.done))
    : clients

  function hasDone(client, type) {
    return client.tasks.some((t) => t.task_type === type && t.done)
  }
  function hasPending(client, type) {
    return client.tasks.some((t) => t.task_type === type && !t.done)
  }

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

  function taskCell(client, type) {
    const key = `${client.name}:${type}`
    const busy = creating === key
    if (hasDone(client, type))
      return <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 16 }}>✓</span>
    if (hasPending(client, type))
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

  const missingMailingCount = clients.filter(
    (c) => !c.tasks.some((t) => t.task_type === 'mailing' && t.done),
  ).length

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
                    <th>Проблемные чаты</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleClients.map((c) => {
                    const isExpanded = expanded === c.key
                    const openProblems = c.problems.filter((p) => !RESOLVED.has(p.status))
                    const noMailing = !hasDone(c, 'mailing')
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
                              colSpan={4 + CHECK_TYPES.length}
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
