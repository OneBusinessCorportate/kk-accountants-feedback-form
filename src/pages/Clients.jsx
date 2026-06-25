import React, { useEffect, useState, useMemo } from 'react'
import { fetchProblems, fetchTasks, createTask } from '../lib/api'
import { TASK_TYPE_LABELS } from '../lib/constants'
import { keepOwnProblems } from '../lib/scope'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage } from '../components/States'
import { artyom } from '../lib/artyomClient'
import { canonicalNameByUUID } from '../lib/ingestion'

// Columns shown as checkmark cells — the "Maggie's file" columns
const CHECK_TYPES = ['mailing', 'report', 'receipt']

const RESOLVED = new Set(['fixed', 'explained_accepted'])

function Avatar({ name }) {
  const initials = (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 26, height: 26, borderRadius: '50%', background: '#e0e7ff',
      color: '#4f46e5', fontSize: 11, fontWeight: 700, flexShrink: 0,
    }}>{initials}</span>
  )
}

function ActiveBadge({ active }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 9999,
      fontSize: 10, fontWeight: 700, lineHeight: '16px',
      background: active ? '#dcfce7' : '#f1f5f9',
      color: active ? '#16a34a' : '#94a3b8',
    }}>{active ? 'Активен' : 'Неактивен'}</span>
  )
}

export default function Clients() {
  const { access, canManage } = useAuth()
  const [problems, setProblems] = useState([])
  const [tasks, setTasks] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [onlyNoMailing, setOnlyNoMailing] = useState(false)
  const [creating, setCreating] = useState(null)
  const [activeTab, setActiveTab] = useState('registry')
  const [searchQuery, setSearchQuery] = useState('')
  const [accountantFilter, setAccountantFilter] = useState('all')
  const [showInactive, setShowInactive] = useState(false)
  // canonical name from ingestion map (e.g. "Lilit Accounting" for "Lilit Khosrovyan")
  const canonicalName = access?.id ? canonicalNameByUUID(access.id) : null

  useEffect(() => {
    let active = true
    setLoading(true)

    const problemsAndTasks = Promise.all([fetchProblems(), fetchTasks()])

    const companiesQ = artyom
      ? artyom.from('ob_accounting_companies')
          .select('id, company_name, contract_number, accountant_name, is_active, armsoft_company_id, tax_account_id')
          .order('company_name')
      : Promise.resolve({ data: [] })

    Promise.all([problemsAndTasks, companiesQ])
      .then(([[p, t], { data: comp }]) => {
        if (!active) return
        setProblems(keepOwnProblems(p, access).filter(x => x.verdict !== 'not_problematic'))
        setTasks(t)
        setCompanies(comp ?? [])
      })
      .catch(setError)
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [access])

  // ─── Registry tab ────────────────────────────────────────────────────────────

  const accountantNames = useMemo(() => {
    const names = new Set()
    for (const c of companies) if (c.accountant_name) names.add(c.accountant_name)
    return Array.from(names).sort()
  }, [companies])

  const filteredCompanies = useMemo(() => {
    // Regular accountants see their own clients by default; managers see all.
    // canonicalName bridges "Lilit Khosrovyan" → "Lilit Accounting" stored in ob_accounting_companies.
    const selfName = !canManage ? (canonicalName || access?.full_name) : null
    const effectiveFilter = accountantFilter !== 'all' ? accountantFilter
      : selfName ? selfName
      : 'all'

    return companies.filter(c => {
      if (effectiveFilter !== 'all' && c.accountant_name !== effectiveFilter) return false
      if (!showInactive && !c.is_active) return false
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const nameMatch = c.company_name?.toLowerCase().includes(q)
        const contractMatch = c.contract_number?.toLowerCase().includes(q)
        const accMatch = c.accountant_name?.toLowerCase().includes(q)
        if (!nameMatch && !contractMatch && !accMatch) return false
      }
      return true
    })
  }, [companies, accountantFilter, showInactive, searchQuery, access, canManage, canonicalName])

  const registrySummary = useMemo(() => {
    const total = filteredCompanies.length
    const active = filteredCompanies.filter(c => c.is_active).length
    return { total, active, inactive: total - active }
  }, [filteredCompanies])

  // ─── Problems tab ─────────────────────────────────────────────────────────────

  const clientMap = new Map()
  for (const p of problems) {
    const name = p.client_name || p.chat_name || '(без имени)'
    if (!clientMap.has(name)) clientMap.set(name, { problems: [], tasks: [] })
    clientMap.get(name).problems.push(p)
  }
  for (const t of tasks) {
    if (t.client_name && clientMap.has(t.client_name)) {
      clientMap.get(t.client_name).tasks.push(t)
    }
  }

  let clients = [...clientMap.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => {
      const aOpen = a.problems.filter(p => !RESOLVED.has(p.status)).length
      const bOpen = b.problems.filter(p => !RESOLVED.has(p.status)).length
      return bOpen - aOpen || a.name.localeCompare(b.name)
    })

  if (onlyNoMailing) {
    clients = clients.filter(c => !c.tasks.some(t => t.task_type === 'mailing' && t.done))
  }

  function hasDone(client, type) { return client.tasks.some(t => t.task_type === type && t.done) }
  function hasPending(client, type) { return client.tasks.some(t => t.task_type === type && !t.done) }

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
      setTasks(prev => [created, ...prev])
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
      <button className="btn btn-secondary btn-sm" disabled={busy}
        onClick={e => { e.stopPropagation(); handleQuickCreate(client.name, type) }}
        title={`Создать: ${TASK_TYPE_LABELS[type]}`}
        style={{ padding: '2px 8px', fontSize: 13, color: 'var(--muted)' }}>
        {busy ? '...' : '+'}
      </button>
    )
  }

  const missingMailingCount = [...clientMap.values()].filter(
    c => !c.tasks.some(t => t.task_type === 'mailing' && t.done)
  ).length

  // ─── Effective display name for the registry tab header ─────────────────────

  const displayAccountant = accountantFilter !== 'all' ? accountantFilter
    : (!canManage && access?.full_name) ? access.full_name
    : null

  return (
    <div>
      <h1 className="page-title">Клиенты</h1>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e2e8f0' }}>
        {[
          ['registry', `📋 Реестр (${registrySummary.active} акт.)`],
          ['problems', `⚠️ Проблемные (${clients.length})`],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{
            padding: '8px 20px', fontSize: 13, fontWeight: 600, border: 'none',
            borderBottom: activeTab === key ? '2px solid #4f46e5' : '2px solid transparent',
            marginBottom: -2, cursor: 'pointer', background: 'none',
            color: activeTab === key ? '#4f46e5' : '#64748b',
          }}>{label}</button>
        ))}
      </div>

      <ErrorMessage error={error} />
      {loading ? <Loading /> : null}

      {/* ── REGISTRY TAB ── */}
      {!loading && activeTab === 'registry' && (
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Поиск по названию или договору…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                padding: '7px 12px', borderRadius: 10, border: '1px solid #e2e8f0',
                fontSize: 13, minWidth: 220, outline: 'none',
              }}
            />
            {canManage && (
              <select value={accountantFilter} onChange={e => setAccountantFilter(e.target.value)}
                style={{ padding: '7px 12px', borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13, background: 'white' }}>
                <option value="all">Все бухгалтеры</option>
                {accountantNames.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
              Показать неактивных
            </label>
            <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 4 }}>
              {registrySummary.total} компаний · {registrySummary.active} активных
              {displayAccountant && <> · <strong>{displayAccountant}</strong></>}
            </span>
          </div>

          {filteredCompanies.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#94a3b8' }}>
              <p style={{ fontSize: 32, marginBottom: 8 }}>📭</p>
              <p style={{ fontSize: 14, fontWeight: 500 }}>Нет компаний по выбранным фильтрам</p>
              {!showInactive && <p style={{ fontSize: 12, marginTop: 4 }}>Попробуйте включить «Показать неактивных»</p>}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Компания</th>
                    <th>Бухгалтер</th>
                    <th style={{ textAlign: 'center' }}>Дог. №</th>
                    <th style={{ textAlign: 'center' }}>Статус</th>
                    {canManage && <th style={{ textAlign: 'center' }}>AS / TS</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredCompanies.map((c, i) => (
                    <tr key={c.id} style={{ fontSize: 13 }}>
                      <td style={{ color: '#94a3b8', fontSize: 11, width: 36 }}>{i + 1}</td>
                      <td style={{ fontWeight: 600, maxWidth: 260 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={c.company_name}>
                          {c.company_name}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Avatar name={c.accountant_name || '?'} />
                          <span style={{ fontSize: 12, color: '#475569' }}>{c.accountant_name || '—'}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: 12, color: '#6366f1' }}>
                        {c.contract_number || '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <ActiveBadge active={c.is_active} />
                      </td>
                      {canManage && (
                        <td style={{ textAlign: 'center', fontSize: 11 }}>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
                            {c.armsoft_company_id && (
                              <span style={{ background: '#ede9fe', color: '#7c3aed', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>
                                AS {c.armsoft_company_id}
                              </span>
                            )}
                            {c.tax_account_id && (
                              <span style={{ background: '#dcfce7', color: '#15803d', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace' }}>
                                TS {c.tax_account_id}
                              </span>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── PROBLEMS TAB ── */}
      {!loading && activeTab === 'problems' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 400, fontSize: 13 }}>
              <input type="checkbox" checked={onlyNoMailing} onChange={e => setOnlyNoMailing(e.target.checked)} />
              Только без рассылки
              {missingMailingCount > 0 && (
                <span className="badge badge-amber" style={{ marginLeft: 4 }}>{missingMailingCount}</span>
              )}
            </label>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>✓ выполнено · ○ в работе · «+» нет задачи</span>
          </div>

          {clients.length === 0 ? (
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
                    {CHECK_TYPES.map(t => <th key={t} style={{ textAlign: 'center' }}>{TASK_TYPE_LABELS[t]}</th>)}
                    <th>Проблемные чаты</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map(c => {
                    const isExpanded = expanded === c.name
                    const openProblems = c.problems.filter(p => !RESOLVED.has(p.status))
                    const noMailing = !hasDone(c, 'mailing')
                    const uniqueChats = [
                      ...new Map(
                        c.problems.filter(p => p.chat_link)
                          .map(p => [p.chat_link, { name: p.chat_name || 'Чат', link: p.chat_link }])
                      ).values(),
                    ]
                    return (
                      <React.Fragment key={c.name}>
                        <tr onClick={() => setExpanded(isExpanded ? null : c.name)}
                          style={{ cursor: 'pointer', background: noMailing && openProblems.length > 0 ? '#fffbf0' : undefined }}>
                          <td style={{ fontWeight: 600 }}>{c.name}</td>
                          <td>
                            {openProblems.length > 0
                              ? <span style={{ color: 'var(--red)', fontWeight: 600 }}>⚠ {openProblems.length}</span>
                              : <span style={{ color: 'var(--green)' }}>✓ 0</span>}
                          </td>
                          {CHECK_TYPES.map(t => (
                            <td key={t} style={{ textAlign: 'center' }}>{taskCell(c, t)}</td>
                          ))}
                          <td>
                            {uniqueChats.slice(0, 3).map(ch => (
                              <a key={ch.link} href={ch.link} target="_blank" rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
                                {ch.name}
                              </a>
                            ))}
                            {uniqueChats.length > 3 && <span style={{ color: 'var(--muted)', fontSize: 12 }}>+{uniqueChats.length - 3}</span>}
                            {uniqueChats.length === 0 && <span style={{ color: 'var(--muted)' }}>—</span>}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={3 + CHECK_TYPES.length} style={{ background: 'var(--bg)', padding: '10px 16px' }}>
                              {c.problems.map(p => (
                                <div key={p.problem_id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6, fontSize: 13 }}>
                                  <span className={`badge ${RESOLVED.has(p.status) ? 'badge-green' : 'badge-amber'}`}>
                                    {RESOLVED.has(p.status) ? 'Решено' : 'Открыта'}
                                  </span>
                                  <span style={{ fontWeight: 500 }}>{p.problem_title || 'Проблема'}</span>
                                  {p.accountant_name && <span style={{ color: 'var(--muted)' }}>{p.accountant_name}</span>}
                                  {p.chat_link && <a href={p.chat_link} target="_blank" rel="noopener noreferrer">→ чат</a>}
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
