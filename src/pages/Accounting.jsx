import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../lib/AuthContext'
import { artyom, artyomConfigError } from '../lib/artyomClient'
import { supabase } from '../lib/supabaseClient'
import { mainProject, normalizeContractNo, splitContractNos } from '../lib/mainClient'
import '../accounting.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const DOC_TYPE_LABEL = {
  invoice: 'Инвойсы',
  report: 'Отчётность',
  application: 'Заявления',
  balance_change: 'Изменения остатков',
}

const DOC_TYPE_ICON = {
  invoice: '🧾',
  report: '📋',
  application: '📝',
  balance_change: '⚖️',
}

const DOC_FIELD = {
  invoice: 'invoices_issued',
  report: 'reports_submitted',
  application: 'applications_filed',
  balance_change: 'balance_changes',
}

const SRC_LABEL = { base: 'База', armsoft: 'АрмСофт', taxservice: 'ТаксСервис' }
const SRC_PILL = {
  base: 'bg-blue-100 text-blue-700',
  armsoft: 'bg-violet-100 text-violet-700',
  taxservice: 'bg-emerald-100 text-emerald-700',
}

const DEAL_STAGE_STYLE = {
  'First Payment / Success': 'bg-emerald-100 text-emerald-700',
  'In Agr. list -> Waiting for Payment': 'bg-amber-100 text-amber-700',
  'Signing': 'bg-sky-100 text-sky-700',
  'Closed Lost': 'bg-rose-100 text-rose-600',
}
function dealStageStyle(stage) {
  return DEAL_STAGE_STYLE[stage] ?? 'bg-slate-100 text-slate-600'
}
function dealStageShort(stage) {
  if (!stage) return ''
  if (stage === 'First Payment / Success') return 'Активен'
  if (stage === 'In Agr. list -> Waiting for Payment') return 'Ожидает оплаты'
  if (stage === 'Signing') return 'Подписание'
  if (stage === 'Closed Lost') return 'Закрыт'
  return stage.length > 28 ? stage.slice(0, 26) + '…' : stage
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() { return new Date().toISOString().split('T')[0] }
function nDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]
}
function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`
}
function fmtMoney(v) {
  if (v == null) return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (isNaN(n)) return String(v)
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}
function emptyTotals() { return { invoices: 0, reports: 0, applications: 0, balance: 0 } }

// ─── UI atoms ─────────────────────────────────────────────────────────────────

function Spinner() {
  return <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
}

function KpiCard({ label, value, sub, icon, accent }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex gap-4 items-center">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0 ${accent}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider leading-none mb-1">{label}</p>
        <p className="text-2xl font-bold text-slate-900 leading-none">{value}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

function SourcePill({ src }) {
  if (src === 'all') {
    return <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600">Все системы</span>
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${SRC_PILL[src] ?? 'bg-slate-100 text-slate-500'}`}>
      {SRC_LABEL[src] ?? src}
    </span>
  )
}

function Avatar({ name }) {
  const initials = (name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
  return (
    <span className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
      {initials}
    </span>
  )
}

function MetricGrid({ t, dim, context, onCellClick }) {
  const empty = t.invoices === 0 && t.reports === 0 && t.applications === 0 && t.balance === 0
  if (empty) return <span className="text-slate-300 text-sm select-none">—</span>

  const cell = (count, docType) => {
    if (context && onCellClick && count > 0) {
      return (
        <button
          onClick={() => onCellClick({ ...context, document_type: docType })}
          className="font-semibold text-indigo-700 hover:text-indigo-900 hover:underline cursor-pointer tabular-nums leading-none"
        >
          {count}
        </button>
      )
    }
    return <span className={`font-semibold tabular-nums ${count === 0 ? 'text-slate-300' : 'text-slate-800'}`}>{count}</span>
  }

  return (
    <div className={`grid grid-cols-4 gap-x-3 text-xs text-right min-w-[130px] ${dim ? 'opacity-50' : ''}`}>
      <span className="text-slate-400 font-medium">Инв</span>
      <span className="text-slate-400 font-medium">Отч</span>
      <span className="text-slate-400 font-medium">Зая</span>
      <span className="text-slate-400 font-medium">Ост</span>
      {cell(t.invoices, 'invoice')}
      {cell(t.reports, 'report')}
      {cell(t.applications, 'application')}
      {cell(t.balance, 'balance_change')}
    </div>
  )
}

// ─── Document Detail Modal ─────────────────────────────────────────────────────

function DocumentDetailModal({ params, onClose }) {
  const [acts, setActs] = useState([])
  const [manualDocs, setManualDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [activeTab, setActiveTab] = useState('activity')
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState({
    document_number: '', document_date: todayStr(), description: '', amount: '', period: '', notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [expandedAct, setExpandedAct] = useState(null) // { actId, docType }
  const [actDocs, setActDocs] = useState({}) // key `actId:docType` → array of document_records
  const [actDocsLoading, setActDocsLoading] = useState({})

  const fetchAll = useCallback(async () => {
    if (!artyom) return
    setLoading(true); setFetchError('')
    setExpandedAct(null); setActDocs({}); setActDocsLoading({})
    try {
      const field = DOC_FIELD[params.document_type]

      let actQ = artyom
        .from('accounting_activities')
        .select('*')
        .eq('company_name', params.company_name)
        .gte('activity_date', params.date_from)
        .lte('activity_date', params.date_to)
        .order('activity_date', { ascending: false })

      if (params.accountant_name && params.accountant_name !== '—') {
        actQ = actQ.eq('accountant_name', params.accountant_name)
      }
      if (params.system_source !== 'all') {
        actQ = actQ.eq('system_source', params.system_source)
      }

      let docQ = artyom
        .from('document_records')
        .select('*')
        .eq('company_name', params.company_name)
        .eq('document_type', params.document_type)
        .gte('document_date', params.date_from)
        .lte('document_date', params.date_to)
        .order('document_date', { ascending: false })

      if (params.system_source !== 'all') docQ = docQ.eq('system_source', params.system_source)
      if (params.accountant_name && params.accountant_name !== '—') {
        docQ = docQ.eq('accountant_name', params.accountant_name)
      }

      const [{ data: actData }, { data: docData }] = await Promise.all([actQ, docQ])

      const relevant = (actData ?? []).filter(a => (a[field] ?? 0) > 0)
        .sort((a, b) => b.activity_date.localeCompare(a.activity_date))
      setActs(relevant)
      setManualDocs(docData ?? [])
    } catch (e) {
      setFetchError(String(e))
    } finally {
      setLoading(false)
    }
  }, [params])

  const toggleActDocs = useCallback(async (act, docType) => {
    const key = `${act.id}:${docType}`
    if (expandedAct?.key === key) { setExpandedAct(null); return }
    setExpandedAct({ key, actId: act.id, docType })
    if (actDocs[key] !== undefined) return
    setActDocsLoading(p => ({ ...p, [key]: true }))
    try {
      const { data } = await artyom
        .from('document_records')
        .select('*')
        .eq('company_name', params.company_name)
        .eq('document_type', docType)
        .eq('document_date', act.activity_date)
        .eq('system_source', act.system_source)
        .order('document_date', { ascending: false })
      setActDocs(p => ({ ...p, [key]: data ?? [] }))
    } catch { setActDocs(p => ({ ...p, [key]: [] })) }
    finally { setActDocsLoading(p => ({ ...p, [key]: false })) }
  }, [expandedAct, actDocs, params])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleSave = async () => {
    if (!artyom) return
    setSaving(true); setSaveError('')
    try {
      const body = {
        company_name: params.company_name,
        accountant_name: params.accountant_name !== '—' ? params.accountant_name : null,
        document_type: params.document_type,
        system_source: params.system_source !== 'all' ? params.system_source : 'base',
        document_number: addForm.document_number || null,
        document_date: addForm.document_date,
        description: addForm.description || null,
        amount: addForm.amount ? parseFloat(addForm.amount) : null,
        period: addForm.period || null,
        notes: addForm.notes || null,
      }
      const { error } = await artyom.from('document_records').insert([body])
      if (error) throw new Error(error.message)
      setShowAddForm(false)
      setAddForm({ document_number: '', document_date: todayStr(), description: '', amount: '', period: '', notes: '' })
      fetchAll()
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const field = DOC_FIELD[params.document_type]
  const totalActivityCount = acts.reduce((s, a) => s + (a[field] ?? 0), 0)
  const sysLabel = params.system_source !== 'all' ? (SRC_LABEL[params.system_source] ?? params.system_source) : 'Все системы'

  const tabs = [
    { key: 'activity', label: 'Активность по дням', count: acts.length },
    { key: 'manual_docs', label: 'Прикреплённые', count: manualDocs.length },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                <span className="text-xl">{DOC_TYPE_ICON[params.document_type]}</span>
                <h2 className="font-bold text-slate-900 text-lg leading-tight">{DOC_TYPE_LABEL[params.document_type]}</h2>
                <span className="text-slate-300 font-light text-lg">·</span>
                <span className="font-semibold text-slate-700 text-lg leading-tight truncate max-w-[280px]">{params.company_name}</span>
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <SourcePill src={params.system_source} />
                <span className="text-xs text-slate-400">{fmtDate(params.date_from)} — {fmtDate(params.date_to)}</span>
                {params.accountant_name && params.accountant_name !== '—' && (
                  <div className="flex items-center gap-1.5">
                    <Avatar name={params.accountant_name} />
                    <span className="text-xs text-slate-600">{params.accountant_name}</span>
                  </div>
                )}
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none flex-shrink-0 mt-0.5">×</button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : fetchError ? (
          <div className="px-6 py-8 text-center text-rose-500 text-sm">{fetchError}</div>
        ) : (
          <>
            <div className="flex overflow-x-auto border-b border-slate-100 flex-shrink-0 bg-slate-50/50">
              {tabs.map(t => (
                <button key={t.key} onClick={() => setActiveTab(t.key)}
                  className={`px-4 py-2.5 text-xs font-semibold whitespace-nowrap flex items-center gap-1.5 border-b-2 transition-colors ${
                    activeTab === t.key ? 'border-indigo-600 text-indigo-700 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}>
                  {t.label}
                  {t.count > 0 && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full tabular-nums ${
                      activeTab === t.key ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-600'
                    }`}>{t.count}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {activeTab === 'activity' && (
                <div>
                  {acts.length === 0 ? (
                    <div className="px-5 py-10 text-center text-slate-400 text-xs">Нет активностей за выбранный период</div>
                  ) : (
                    <>
                      <div className="px-5 py-2.5 bg-slate-50 flex items-center justify-between border-b border-slate-100 flex-wrap gap-2">
                        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Активность по дням</span>
                        <div className="flex gap-2 flex-wrap text-[11px] font-semibold">
                          <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">Инв: {acts.reduce((s,a)=>s+(a.invoices_issued??0),0)}</span>
                          <span className="bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full">Отч: {acts.reduce((s,a)=>s+(a.reports_submitted??0),0)}</span>
                          <span className="bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">Зая: {acts.reduce((s,a)=>s+(a.applications_filed??0),0)}</span>
                          <span className="bg-rose-50 text-rose-700 px-2 py-0.5 rounded-full">Ост: {acts.reduce((s,a)=>s+(a.balance_changes??0),0)}</span>
                        </div>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-100">
                            <th className="text-left px-5 py-2">Дата</th>
                            <th className="text-left px-4 py-2">Бухгалтер</th>
                            <th className="text-left px-4 py-2">Система</th>
                            <th className="text-right px-3 py-2 bg-indigo-50/60">Инв</th>
                            <th className="text-right px-3 py-2">Отч</th>
                            <th className="text-right px-3 py-2">Зая</th>
                            <th className="text-right px-3 py-2">Ост</th>
                            <th className="text-right px-4 py-2 text-slate-400">Добавлено</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {acts.map(a => {
                            const isExpanded = expandedAct?.actId === a.id
                            const expandKey = isExpanded ? expandedAct.key : null
                            const docs = expandKey ? (actDocs[expandKey] ?? []) : []
                            const docsLoading = expandKey ? !!actDocsLoading[expandKey] : false
                            const countBtn = (count, docType, colorOn, colorOff, bg) => (
                              count > 0
                                ? <button onClick={() => toggleActDocs(a, docType)}
                                    className={`tabular-nums text-xs font-bold ${colorOn} hover:underline cursor-pointer`}>
                                    {count}
                                  </button>
                                : <span className={`tabular-nums text-xs font-bold ${colorOff}`}>{count}</span>
                            )
                            return (
                              <React.Fragment key={a.id}>
                                <tr className={`hover:bg-indigo-50/20 ${isExpanded ? 'bg-indigo-50/10' : ''}`}>
                                  <td className="px-5 py-2.5 text-xs font-semibold text-slate-700 whitespace-nowrap">{fmtDate(a.activity_date)}</td>
                                  <td className="px-4 py-2.5">
                                    <div className="flex items-center gap-1.5">
                                      <Avatar name={a.accountant_name} />
                                      <div>
                                        <span className="text-xs text-slate-600 block">{a.accountant_name}</span>
                                        {a.accountant_email && <span className="text-[10px] text-slate-400 block">{a.accountant_email}</span>}
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5"><SourcePill src={a.system_source} /></td>
                                  <td className="px-3 py-2.5 text-right bg-indigo-50/30">
                                    {countBtn(a.invoices_issued ?? 0, 'invoice', 'text-indigo-700', 'text-slate-300')}
                                  </td>
                                  <td className="px-3 py-2.5 text-right">
                                    {countBtn(a.reports_submitted ?? 0, 'report', 'text-violet-700', 'text-slate-300')}
                                  </td>
                                  <td className="px-3 py-2.5 text-right">
                                    {countBtn(a.applications_filed ?? 0, 'application', 'text-amber-700', 'text-slate-300')}
                                  </td>
                                  <td className="px-3 py-2.5 text-right">
                                    {countBtn(a.balance_changes ?? 0, 'balance_change', 'text-rose-700', 'text-slate-300')}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-[10px] text-slate-400 whitespace-nowrap">
                                    {a.created_at ? new Date(a.created_at).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—'}
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr>
                                    <td colSpan={8} className="px-5 py-3 bg-indigo-50/40 border-b border-indigo-100">
                                      {docsLoading ? (
                                        <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Загрузка документов…</div>
                                      ) : docs.length === 0 ? (
                                        <p className="text-xs text-slate-400 italic">Нет связанных документов за этот день</p>
                                      ) : (
                                        <table className="w-full text-xs border-collapse">
                                          <thead>
                                            <tr className="text-[10px] text-slate-500 font-semibold uppercase border-b border-indigo-100">
                                              <th className="text-left pb-1 pr-4">№ документа</th>
                                              <th className="text-left pb-1 pr-4">Дата</th>
                                              <th className="text-left pb-1 pr-4">Описание</th>
                                              <th className="text-right pb-1 pr-4">Сумма</th>
                                              <th className="text-left pb-1 pr-4">Период</th>
                                              <th className="text-left pb-1">Заметки</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-indigo-100/60">
                                            {docs.map(doc => (
                                              <tr key={doc.id} className="hover:bg-white/60">
                                                <td className="py-1.5 pr-4 font-mono text-indigo-600 whitespace-nowrap">{doc.document_number ?? '—'}</td>
                                                <td className="py-1.5 pr-4 text-slate-600 whitespace-nowrap">{fmtDate(doc.document_date)}</td>
                                                <td className="py-1.5 pr-4 text-slate-700 max-w-[200px]"><span className="block truncate" title={doc.description ?? undefined}>{doc.description ?? '—'}</span></td>
                                                <td className="py-1.5 pr-4 text-right font-mono font-semibold text-slate-700 whitespace-nowrap">{doc.amount != null ? fmtMoney(doc.amount) : '—'}</td>
                                                <td className="py-1.5 pr-4 text-slate-600 whitespace-nowrap">{doc.period ?? '—'}</td>
                                                <td className="py-1.5 text-slate-500 max-w-[150px]"><span className="block truncate" title={doc.notes ?? undefined}>{doc.notes ?? '—'}</span></td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            )
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-indigo-50/50 border-t border-indigo-100 text-xs font-bold">
                            <td className="px-5 py-2 text-slate-500" colSpan={3}>Итого</td>
                            <td className="px-3 py-2 text-right text-indigo-700 tabular-nums bg-indigo-50/60">{acts.reduce((s,a) => s+(a.invoices_issued??0),0)}</td>
                            <td className="px-3 py-2 text-right text-violet-700 tabular-nums">{acts.reduce((s,a) => s+(a.reports_submitted??0),0)}</td>
                            <td className="px-3 py-2 text-right text-amber-700 tabular-nums">{acts.reduce((s,a) => s+(a.applications_filed??0),0)}</td>
                            <td className="px-3 py-2 text-right text-rose-700 tabular-nums">{acts.reduce((s,a) => s+(a.balance_changes??0),0)}</td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'manual_docs' && (
                <div>
                  <div className="px-5 py-2.5 bg-slate-50 flex items-center justify-between border-b border-slate-100">
                    <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Прикреплённые документы</span>
                    {manualDocs.length > 0 && <span className="text-xs text-slate-400">{manualDocs.length} шт.</span>}
                  </div>
                  {manualDocs.length === 0 && !showAddForm ? (
                    <div className="px-5 py-8 text-center text-slate-400 text-xs">Документы не прикреплены</div>
                  ) : manualDocs.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-100">
                            <th className="text-left px-4 py-2">#</th>
                            <th className="text-left px-4 py-2 whitespace-nowrap">Дата</th>
                            <th className="text-left px-4 py-2 whitespace-nowrap">№ документа</th>
                            <th className="text-left px-4 py-2">Описание</th>
                            <th className="text-right px-4 py-2 whitespace-nowrap">Сумма</th>
                            <th className="text-left px-4 py-2">Период</th>
                            <th className="text-left px-4 py-2">Заметки</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {manualDocs.map((doc, i) => (
                            <tr key={doc.id} className={`hover:bg-indigo-50/20 ${i % 2 ? 'bg-slate-50/20' : ''}`}>
                              <td className="px-4 py-2.5 text-slate-400 font-mono text-xs">{i + 1}</td>
                              <td className="px-4 py-2.5 text-xs font-medium text-slate-700 whitespace-nowrap">{fmtDate(doc.document_date)}</td>
                              <td className="px-4 py-2.5 font-mono text-xs text-indigo-600 whitespace-nowrap">{doc.document_number ?? '—'}</td>
                              <td className="px-4 py-2.5 text-xs text-slate-700 max-w-[180px]"><span className="block truncate" title={doc.description ?? undefined}>{doc.description ?? '—'}</span></td>
                              <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold text-slate-700 whitespace-nowrap">{doc.amount != null ? fmtMoney(doc.amount) : '—'}</td>
                              <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">{doc.period ?? '—'}</td>
                              <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[150px]"><span className="block truncate" title={doc.notes ?? undefined}>{doc.notes ?? '—'}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {showAddForm && (
                    <div className="px-6 py-5 border-t border-slate-100 bg-slate-50/50">
                      <h3 className="text-sm font-semibold text-slate-700 mb-4">Новый документ</h3>
                      {saveError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{saveError}</p>}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Дата *</span>
                          <input type="date" value={addForm.document_date}
                            onChange={e => setAddForm(f => ({ ...f, document_date: e.target.value }))}
                            className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">№ документа</span>
                          <input type="text" placeholder="ИНВ-001" value={addForm.document_number}
                            onChange={e => setAddForm(f => ({ ...f, document_number: e.target.value }))}
                            className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block sm:col-span-2">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Описание</span>
                          <input type="text" placeholder="Краткое описание документа" value={addForm.description}
                            onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                            className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Сумма</span>
                          <input type="number" placeholder="0" value={addForm.amount}
                            onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))}
                            className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Период</span>
                          <input type="text" placeholder="июнь 2026" value={addForm.period}
                            onChange={e => setAddForm(f => ({ ...f, period: e.target.value }))}
                            className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                        </label>
                        <label className="block sm:col-span-2">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Заметки</span>
                          <textarea rows={2} placeholder="Дополнительная информация" value={addForm.notes}
                            onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                            className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
                        </label>
                      </div>
                      <div className="flex flex-wrap justify-between items-center mt-4 gap-2">
                        <p className="text-xs text-slate-400">{params.company_name} · {DOC_TYPE_LABEL[params.document_type]} · {sysLabel}</p>
                        <div className="flex gap-2">
                          <button onClick={() => { setShowAddForm(false); setSaveError('') }}
                            className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-200 transition-colors">Отмена</button>
                          <button onClick={handleSave} disabled={saving}
                            className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                            {saving ? 'Сохранение…' : 'Сохранить'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-3.5 border-t border-slate-100 flex-shrink-0 flex justify-between items-center bg-slate-50/30">
              <span className="text-xs text-slate-400">Активностей: {acts.length} · Прикреплено: {manualDocs.length}</span>
              {activeTab === 'manual_docs' && !showAddForm && (
                <button onClick={() => setShowAddForm(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
                  + Добавить документ
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Add Comment Modal ─────────────────────────────────────────────────────────

function AddCommentModal({ accountantNames, companies, access, canManage, onSave, onClose }) {
  const defaultName = canManage ? (accountantNames[0] ?? '') : (access?.full_name ?? '')
  const [form, setForm] = useState({
    accountant_name: defaultName,
    company_name: '',
    comment: '',
    unaccounted_work: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const handleSave = async () => {
    if (!form.accountant_name || !form.comment.trim()) { setErr('Укажите бухгалтера и комментарий'); return }
    setSaving(true); setErr('')
    try { await onSave(form) } catch (e) { setErr(String(e)); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Добавить комментарий к рабочему дню</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {err && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{err}</p>}
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Бухгалтер *</span>
            {canManage ? (
              <select value={form.accountant_name} onChange={e => setForm(f => ({ ...f, accountant_name: e.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
                {accountantNames.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            ) : (
              <p className="mt-1 px-3 py-2.5 bg-slate-50 rounded-xl text-sm text-slate-700 font-medium border border-slate-200">{form.accountant_name}</p>
            )}
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Компания</span>
            <select value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))}
              className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
              <option value="">— Не выбрано —</option>
              {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Что сделано *</span>
            <textarea rows={3} placeholder="Опишите, что было сделано за день…"
              className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Что не учтено в таблице</span>
            <textarea rows={2} placeholder="Работа, которая не отражена в цифрах…"
              className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              value={form.unaccounted_work} onChange={e => setForm(f => ({ ...f, unaccounted_work: e.target.value }))} />
          </label>
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl text-sm text-slate-600 hover:bg-slate-100">Отмена</button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Accounting Dashboard ─────────────────────────────────────────────────

export default function Accounting() {
  const { access, canManage } = useAuth()

  const [employees, setEmployees] = useState([])
  const [companies, setCompanies] = useState([])
  const [activities, setActivities] = useState([])
  const [comments, setComments] = useState([])
  const [dealMap, setDealMap] = useState(new Map()) // normalizedContractNo → deal row

  const [dateFrom, setDateFrom] = useState(nDaysAgo(29))
  const [dateTo, setDateTo] = useState(todayStr())
  const [accountantFilter, setAccountantFilter] = useState('all')
  const [companyFilter, setCompanyFilter] = useState('all')
  const [source, setSource] = useState('all')
  const [activeTab, setActiveTab] = useState('companies')
  const [showModal, setShowModal] = useState(false)
  const [detailModal, setDetailModal] = useState(null)

  const [loadingStatic, setLoadingStatic] = useState(true)
  const [loadingDynamic, setLoadingDynamic] = useState(false)

  // Accounting page is a shared reporting tool — everyone sees all data and can filter.
  // (Per-accountant scoping applies to the Problems/Dashboard, not here.)
  const effectiveAccountant = accountantFilter

  if (artyomConfigError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <div className="bg-white rounded-2xl border border-red-200 shadow p-8 max-w-lg text-center">
          <p className="text-4xl mb-4">⚠️</p>
          <h2 className="font-bold text-slate-800 text-lg mb-2">Отчётность недоступна</h2>
          <p className="text-sm text-slate-500">{artyomConfigError}</p>
          <p className="text-xs text-slate-400 mt-3">Задайте переменные окружения <code>VITE_ARTYOM_SUPABASE_URL</code> и <code>VITE_ARTYOM_SUPABASE_ANON_KEY</code></p>
        </div>
      </div>
    )
  }

  useEffect(() => {
    if (!artyom) return
    const compQ = artyom.from('ob_accounting_companies')
      .select('id, company_name, contract_number, accountant_name, is_active, armsoft_company_id, tax_account_id')
      .order('company_name')

    const empQ = supabase
      ? supabase.from('employees').select('id, full_name, role, is_active').in('role', ['accountant', 'head_accountant']).eq('is_active', true).order('full_name')
      : Promise.resolve({ data: [] })

    // Fetch accounting deals from Main Project (OB CRM sdelki)
    const dealQ = mainProject
      .from('OB')
      .select('"OB/ Agr. №", "Название сделки", "Ответственный", "Этап сделки", "УСЛУГА", "OB/ Agr. Date", "OB/ Type of Agr."')
      .not('OB/ Agr. №', 'is', null)
      .neq('OB/ Agr. №', '')
      .neq('OB/ Agr. №', '-')

    Promise.all([compQ, empQ, dealQ]).then(([{ data: comp }, { data: emp }, { data: deals }]) => {
      setCompanies(comp ?? [])
      const seen = new Set()
      setEmployees((emp ?? []).filter(e => { if (seen.has(e.full_name)) return false; seen.add(e.full_name); return true }))

      // Build map: normalized contract number → deal
      const map = new Map()
      for (const deal of (deals ?? [])) {
        const field = deal['OB/ Agr. №']
        for (const no of splitContractNos(field)) {
          if (!map.has(no)) map.set(no, deal)
        }
      }
      setDealMap(map)
    }).finally(() => setLoadingStatic(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDynamic = useCallback(() => {
    if (!artyom) return
    setLoadingDynamic(true)

    let actQ = artyom
      .from('accounting_activities')
      .select('*')
      .gte('activity_date', dateFrom)
      .lte('activity_date', dateTo)
      .order('activity_date', { ascending: false })

    if (effectiveAccountant !== 'all') actQ = actQ.eq('accountant_name', effectiveAccountant)
    if (companyFilter !== 'all') actQ = actQ.eq('company_name', companyFilter)
    if (source !== 'all') actQ = actQ.eq('system_source', source)

    let comQ = artyom
      .from('accountant_daily_comments')
      .select('*')
      .gte('comment_date', dateFrom)
      .lte('comment_date', dateTo)
      .order('comment_date', { ascending: false })

    if (effectiveAccountant !== 'all') comQ = comQ.eq('accountant_name', effectiveAccountant)

    Promise.all([actQ, comQ]).then(([{ data: act }, { data: com }]) => {
      setActivities(act ?? [])
      setComments(com ?? [])
    }).finally(() => setLoadingDynamic(false))
  }, [dateFrom, dateTo, effectiveAccountant, companyFilter, source])

  useEffect(() => { loadDynamic() }, [loadDynamic])

  const companyIdMap = useMemo(() => {
    const m = new Map()
    for (const c of companies) m.set(c.company_name, c)
    return m
  }, [companies])

  // contractNo → deal: look up deal for a company by its contract_number
  const getDeal = useCallback((contractNo) => {
    if (!contractNo) return null
    return dealMap.get(normalizeContractNo(contractNo)) ?? null
  }, [dealMap])

  const companyRows = useMemo(() => {
    const map = new Map()

    for (const c of companies) {
      if (accountantFilter !== 'all' && canManage && c.accountant_name !== accountantFilter) continue
      if (companyFilter !== 'all' && c.company_name !== companyFilter) continue
      map.set(c.company_name, {
        company_name: c.company_name,
        accountant_name: c.accountant_name ?? '—',
        base: emptyTotals(), armsoft: emptyTotals(), taxservice: emptyTotals(), total: emptyTotals(),
      })
    }

    for (const a of activities) {
      let row = map.get(a.company_name)
      if (!row) {
        row = {
          company_name: a.company_name,
          accountant_name: a.accountant_name,
          base: emptyTotals(), armsoft: emptyTotals(), taxservice: emptyTotals(), total: emptyTotals(),
        }
        map.set(a.company_name, row)
      }
      if (row.accountant_name === '—' && a.accountant_name) row.accountant_name = a.accountant_name
      const sys = row[a.system_source]
      if (sys) {
        sys.invoices += a.invoices_issued ?? 0
        sys.reports += a.reports_submitted ?? 0
        sys.applications += a.applications_filed ?? 0
        sys.balance += a.balance_changes ?? 0
      }
      row.total.invoices += a.invoices_issued ?? 0
      row.total.reports += a.reports_submitted ?? 0
      row.total.applications += a.applications_filed ?? 0
      row.total.balance += a.balance_changes ?? 0
    }

    return Array.from(map.values()).sort((a, b) => {
      const aHas = a.total.invoices + a.total.reports + a.total.applications + a.total.balance
      const bHas = b.total.invoices + b.total.reports + b.total.applications + b.total.balance
      if (aHas !== bHas) return bHas - aHas
      return a.company_name.localeCompare(b.company_name, 'ru')
    })
  }, [activities, companies, accountantFilter, companyFilter, canManage])

  const kpi = useMemo(() => companyRows.reduce(
    (acc, r) => ({ invoices: acc.invoices + r.total.invoices, reports: acc.reports + r.total.reports, applications: acc.applications + r.total.applications, balance: acc.balance + r.total.balance }),
    emptyTotals()
  ), [companyRows])

  // Companies with activity data that aren't formally registered in ob_accounting_companies.
  // Uses current filtered activities so managers can scope the gap check by date/accountant.
  const orphanActivities = useMemo(() => {
    const obNames = new Set(companies.map(c => c.company_name.trim().toLowerCase()))
    const seen = new Map()
    for (const a of activities) {
      const key = a.company_name?.trim().toLowerCase()
      if (key && !obNames.has(key) && !seen.has(key)) {
        seen.set(key, { company_name: a.company_name, accountant_name: a.accountant_name || '—' })
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.company_name.localeCompare(b.company_name, 'ru'))
  }, [companies, activities])

  // Combine KK employees (from main Supabase) with Artyom-specific accountant names
  // from ob_accounting_companies (e.g. "OB Accounting", "Tatev Altunyan") so the
  // filter dropdown shows everyone with data.
  const accountantList = useMemo(() => {
    const names = new Set(employees.map(e => e.full_name))
    for (const c of companies) if (c.accountant_name) names.add(c.accountant_name)
    return Array.from(names).sort()
  }, [employees, companies])

  const handleAddComment = async (form) => {
    if (!artyom) throw new Error('Artyom DB не настроен')
    const { error } = await artyom.from('accountant_daily_comments').insert([{
      accountant_name: form.accountant_name,
      company_name: form.company_name || null,
      comment_date: todayStr(),
      comment: form.comment.trim(),
      unaccounted_work: form.unaccounted_work?.trim() || null,
    }])
    if (error) throw new Error(error.message)
    setShowModal(false)
    loadDynamic()
  }

  const setPreset = (p) => {
    const t = todayStr()
    if (p === 'today') { setDateFrom(t); setDateTo(t) }
    else if (p === 'week') { setDateFrom(nDaysAgo(6)); setDateTo(t) }
    else { setDateFrom(nDaysAgo(29)); setDateTo(t) }
  }

  const loading = loadingStatic || loadingDynamic

  // Companies with a matched deal
  const companiesWithDeal = useMemo(() => {
    return companies.filter(c => c.contract_number && getDeal(c.contract_number))
  }, [companies, getDeal])

  const tabs = [
    ['companies', `По компаниям (${companyRows.length})`],
    ['deals', `📋 Сделки (${companiesWithDeal.length})`],
    ['missing', `⚠️ Пробелы${orphanActivities.length > 0 ? ` (${orphanActivities.length})` : ''}`],
    ['comments', `💬 Комментарии (${comments.length})`],
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-4 space-y-6">

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-slate-800 mr-2">Отчётность бухгалтерии</span>

          <select value={accountantFilter} onChange={e => setAccountantFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
            <option value="all">Все бухгалтеры</option>
            {accountantList.map(a => <option key={a} value={a}>{a}</option>)}
          </select>

          <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
            <option value="all">Все компании</option>
            {companies.map(c => <option key={c.id} value={c.company_name}>{c.company_name}</option>)}
          </select>

          <select value={source} onChange={e => setSource(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
            <option value="all">Все системы</option>
            <option value="base">База</option>
            <option value="armsoft">АрмСофт</option>
            <option value="taxservice">ТаксСервис</option>
          </select>

          <div className="flex rounded-xl border border-slate-200 overflow-hidden text-[11px] font-semibold bg-white">
            {[['today','Сегодня'],['week','7 дней'],['month','30 дней']].map(([k,l]) => (
              <button key={k} onClick={() => setPreset(k)}
                className="px-3 py-2 hover:bg-indigo-50 hover:text-indigo-700 border-r last:border-r-0 border-slate-200 transition-colors">
                {l}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="border border-slate-200 rounded-xl px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400" />
            <span className="text-slate-400 text-xs">—</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="border border-slate-200 rounded-xl px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400" />
          </div>

          {loading && <Spinner />}
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <KpiCard label="Выписано инвойсов" value={kpi.invoices.toLocaleString('ru-RU')} icon="🧾" accent="bg-emerald-50 text-emerald-600"
            sub={source !== 'all' ? SRC_LABEL[source] : 'все системы'} />
          <KpiCard label="Сдано отчётности" value={kpi.reports.toLocaleString('ru-RU')} icon="📋" accent="bg-violet-50 text-violet-600"
            sub={source !== 'all' ? SRC_LABEL[source] : 'все системы'} />
          <KpiCard label="Подано заявлений" value={kpi.applications.toLocaleString('ru-RU')} icon="📝" accent="bg-amber-50 text-amber-600"
            sub={source !== 'all' ? SRC_LABEL[source] : 'все системы'} />
          <KpiCard label="Изменений остатков" value={kpi.balance.toLocaleString('ru-RU')} icon="⚖️" accent="bg-rose-50 text-rose-600"
            sub={source !== 'all' ? SRC_LABEL[source] : 'все системы'} />
          {canManage && (
            <KpiCard label="Не в реестре" value={orphanActivities.length} icon="⚠️" accent="bg-orange-50 text-orange-500"
              sub={`активны, но без записи · всего в реестре: ${companies.length}`} />
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-slate-200 flex gap-0">
          {tabs.map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === key
                  ? 'border-indigo-600 text-indigo-700 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* TAB 1 — Companies */}
        {activeTab === 'companies' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
              <h2 className="font-semibold text-slate-800 text-sm">
                Активность по компаниям
                {canManage && accountantFilter !== 'all' && <span className="ml-2 text-indigo-600">· {accountantFilter}</span>}
                {!canManage && <span className="ml-2 text-indigo-600">· {access?.full_name}</span>}
                {source !== 'all' && <span className="ml-2"><SourcePill src={source} /></span>}
              </h2>
              <div className="flex gap-1.5 items-center text-xs text-slate-400">
                <SourcePill src="base" /><SourcePill src="armsoft" /><SourcePill src="taxservice" />
                <span className="ml-2">Нажмите на число → документы</span>
              </div>
            </div>

            {companyRows.length === 0 && !loading ? (
              <div className="px-5 py-10 text-center text-slate-400">
                <p className="text-4xl mb-3">📭</p>
                <p className="text-sm font-medium">Нет данных за выбранный период</p>
                {!canManage && (
                  <p className="text-xs text-amber-600 mt-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 inline-block">
                    Ваши задачи могут быть записаны под «OB Accounting» (командный аккаунт).
                    Выберите «OB Accounting» в фильтре бухгалтеров или обратитесь к руководителю.
                  </p>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-200">
                      <th className="text-left px-5 py-3 whitespace-nowrap">Компания</th>
                      <th className="text-left px-4 py-3 whitespace-nowrap">Бухгалтер</th>
                      {(source === 'all' || source === 'base') && <th className="text-center px-4 py-3 whitespace-nowrap bg-blue-50/60 border-x border-blue-100">База</th>}
                      {(source === 'all' || source === 'armsoft') && <th className="text-center px-4 py-3 whitespace-nowrap bg-violet-50/60 border-x border-violet-100">АрмСофт</th>}
                      {(source === 'all' || source === 'taxservice') && <th className="text-center px-4 py-3 whitespace-nowrap bg-emerald-50/60 border-x border-emerald-100">ТаксСервис</th>}
                      <th className="text-center px-4 py-3 whitespace-nowrap font-bold text-slate-700">Итого</th>
                    </tr>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[10px] text-slate-400">
                      <th colSpan={2} />
                      {(source === 'all' || source === 'base') && <th className="py-1 bg-blue-50/40 border-x border-blue-100"><div className="grid grid-cols-4 gap-x-3 text-center px-4 min-w-[130px]"><span>Инв</span><span>Отч</span><span>Зая</span><span>Ост</span></div></th>}
                      {(source === 'all' || source === 'armsoft') && <th className="py-1 bg-violet-50/40 border-x border-violet-100"><div className="grid grid-cols-4 gap-x-3 text-center px-4 min-w-[130px]"><span>Инв</span><span>Отч</span><span>Зая</span><span>Ост</span></div></th>}
                      {(source === 'all' || source === 'taxservice') && <th className="py-1 bg-emerald-50/40 border-x border-emerald-100"><div className="grid grid-cols-4 gap-x-3 text-center px-4 min-w-[130px]"><span>Инв</span><span>Отч</span><span>Зая</span><span>Ост</span></div></th>}
                      <th className="py-1"><div className="grid grid-cols-4 gap-x-3 text-center px-4 min-w-[130px]"><span>Инв</span><span>Отч</span><span>Зая</span><span>Ост</span></div></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {companyRows.map((row, i) => {
                      const comp = companyIdMap.get(row.company_name)
                      const deal = comp ? getDeal(comp.contract_number) : null
                      const ctx = (sys) => ({
                        company_name: row.company_name,
                        accountant_name: row.accountant_name,
                        system_source: sys,
                        date_from: dateFrom,
                        date_to: dateTo,
                      })
                      return (
                        <tr key={row.company_name} className={`hover:bg-indigo-50/30 transition-colors ${i % 2 ? 'bg-slate-50/30' : ''}`}>
                          <td className="px-5 py-3 font-medium text-slate-800 whitespace-nowrap max-w-[240px]">
                            <span className="block truncate" title={row.company_name}>{row.company_name}</span>
                            <div className="flex gap-1 mt-0.5 flex-wrap">
                              {comp?.contract_number && (
                                <span className="text-[9px] text-slate-500 bg-slate-100 px-1 rounded font-mono leading-4">№{comp.contract_number}</span>
                              )}
                              {deal && (
                                <span
                                  className={`text-[9px] px-1.5 rounded leading-4 font-semibold ${dealStageStyle(deal['Этап сделки'])}`}
                                  title={deal['Этап сделки']}
                                >
                                  {dealStageShort(deal['Этап сделки'])}
                                </span>
                              )}
                              {comp?.armsoft_company_id && (
                                <span className="text-[9px] text-violet-600 bg-violet-50 px-1 rounded font-mono leading-4 border border-violet-100">AS {comp.armsoft_company_id}</span>
                              )}
                              {comp?.tax_account_id && (
                                <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1 rounded font-mono leading-4 border border-emerald-100">TS {comp.tax_account_id}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <Avatar name={row.accountant_name} />
                              <span className="text-xs text-slate-600">{row.accountant_name}</span>
                            </div>
                          </td>
                          {(source === 'all' || source === 'base') && <td className="px-4 py-3 bg-blue-50/30 border-x border-blue-100"><MetricGrid t={row.base} context={ctx('base')} onCellClick={setDetailModal} /></td>}
                          {(source === 'all' || source === 'armsoft') && <td className="px-4 py-3 bg-violet-50/30 border-x border-violet-100"><MetricGrid t={row.armsoft} context={ctx('armsoft')} onCellClick={setDetailModal} /></td>}
                          {(source === 'all' || source === 'taxservice') && <td className="px-4 py-3 bg-emerald-50/30 border-x border-emerald-100"><MetricGrid t={row.taxservice} context={ctx('taxservice')} onCellClick={setDetailModal} /></td>}
                          <td className="px-4 py-3">
                            <div className="grid grid-cols-4 gap-x-3 text-xs text-right min-w-[130px]">
                              <span className="font-bold text-slate-900 tabular-nums">{row.total.invoices}</span>
                              <span className="font-bold text-slate-900 tabular-nums">{row.total.reports}</span>
                              <span className="font-bold text-slate-900 tabular-nums">{row.total.applications}</span>
                              <span className="font-bold text-slate-900 tabular-nums">{row.total.balance}</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  {companyRows.length > 1 && (
                    <tfoot>
                      <tr className="bg-indigo-50 border-t-2 border-indigo-200 text-xs font-bold text-slate-700">
                        <td className="px-5 py-3" colSpan={2}>Итого</td>
                        {(source === 'all' || source === 'base') && <td className="px-4 py-3 bg-blue-50/50 border-x border-blue-100" />}
                        {(source === 'all' || source === 'armsoft') && <td className="px-4 py-3 bg-violet-50/50 border-x border-violet-100" />}
                        {(source === 'all' || source === 'taxservice') && <td className="px-4 py-3 bg-emerald-50/50 border-x border-emerald-100" />}
                        <td className="px-4 py-3">
                          <div className="grid grid-cols-4 gap-x-3 text-right min-w-[130px]">
                            <span className="text-indigo-700 tabular-nums">{kpi.invoices.toLocaleString('ru-RU')}</span>
                            <span className="text-violet-700 tabular-nums">{kpi.reports.toLocaleString('ru-RU')}</span>
                            <span className="text-amber-700 tabular-nums">{kpi.applications.toLocaleString('ru-RU')}</span>
                            <span className="text-rose-700 tabular-nums">{kpi.balance.toLocaleString('ru-RU')}</span>
                          </div>
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 2 — Deals (sdelki from Main Project OB table) */}
        {activeTab === 'deals' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="font-semibold text-slate-800 text-sm">Клиенты из CRM (сделки)</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Компании из реестра, у которых найдена сделка в AMO CRM · сопоставление по номеру договора
                </p>
              </div>
              <span className="text-2xl font-bold text-indigo-600">{companiesWithDeal.length}</span>
            </div>
            {companiesWithDeal.length === 0 ? (
              <div className="text-center py-16 text-slate-400">
                <p className="text-3xl mb-2">🔍</p>
                <p className="text-sm font-medium">Сделки не найдены</p>
                <p className="text-xs mt-1">Данные загружаются или нет совпадений по номерам договоров</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-200">
                      <th className="text-left px-5 py-3 whitespace-nowrap">Компания</th>
                      <th className="text-left px-4 py-3 whitespace-nowrap">Бухгалтер</th>
                      <th className="text-left px-4 py-3 whitespace-nowrap">Дог. №</th>
                      <th className="text-left px-4 py-3 whitespace-nowrap">Этап сделки</th>
                      <th className="text-left px-4 py-3 whitespace-nowrap">Дата договора</th>
                      <th className="text-left px-4 py-3 whitespace-nowrap">Услуга</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {companiesWithDeal
                      .filter(c => accountantFilter === 'all' || c.accountant_name === accountantFilter)
                      .map((c, i) => {
                        const deal = getDeal(c.contract_number)
                        if (!deal) return null
                        return (
                          <tr key={c.id} className={`hover:bg-indigo-50/30 transition-colors ${i % 2 ? 'bg-slate-50/20' : ''}`}>
                            <td className="px-5 py-2.5 font-medium text-slate-800 max-w-[200px]">
                              <span className="block truncate" title={c.company_name}>{c.company_name}</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <Avatar name={c.accountant_name || '?'} />
                                <span className="text-xs text-slate-600">{c.accountant_name || '—'}</span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{c.contract_number}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${dealStageStyle(deal['Этап сделки'])}`}>
                                {dealStageShort(deal['Этап сделки'])}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">{fmtDate(deal['OB/ Agr. Date'])}</td>
                            <td className="px-4 py-2.5 text-xs text-slate-600 max-w-[200px]">
                              <span className="block truncate" title={deal['УСЛУГА']}>{deal['УСЛУГА']}</span>
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 3 — Gap analysis (management only) */}
        {activeTab === 'missing' && canManage && (
          <div className="space-y-4">
            {/* Accountant coverage summary */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100">
                <h2 className="font-semibold text-slate-800 text-sm">Покрытие по бухгалтерам</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Число компаний и суммарная активность за выбранный период
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-200">
                      <th className="text-left px-5 py-3">Бухгалтер</th>
                      <th className="text-right px-4 py-3">Компании</th>
                      <th className="text-right px-4 py-3">Инв</th>
                      <th className="text-right px-4 py-3">Отч</th>
                      <th className="text-right px-4 py-3">Зая</th>
                      <th className="text-right px-4 py-3">Ост</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(() => {
                      const byAcc = new Map()
                      for (const row of companyRows) {
                        const acc = row.accountant_name || '—'
                        if (!byAcc.has(acc)) byAcc.set(acc, { companies: 0, invoices: 0, reports: 0, applications: 0, balance: 0 })
                        const s = byAcc.get(acc)
                        s.companies++
                        s.invoices += row.total.invoices
                        s.reports += row.total.reports
                        s.applications += row.total.applications
                        s.balance += row.total.balance
                      }
                      return Array.from(byAcc.entries())
                        .sort((a, b) => (b[1].invoices + b[1].reports + b[1].applications + b[1].balance) - (a[1].invoices + a[1].reports + a[1].applications + a[1].balance))
                        .map(([acc, s]) => (
                          <tr key={acc} className="hover:bg-indigo-50/20 transition-colors">
                            <td className="px-5 py-2.5">
                              <div className="flex items-center gap-2">
                                <Avatar name={acc} />
                                <span className="text-xs font-medium text-slate-700">{acc}</span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-right text-xs font-semibold text-slate-700 tabular-nums">{s.companies}</td>
                            <td className="px-4 py-2.5 text-right text-xs tabular-nums text-indigo-700">{s.invoices || '—'}</td>
                            <td className="px-4 py-2.5 text-right text-xs tabular-nums text-violet-700">{s.reports || '—'}</td>
                            <td className="px-4 py-2.5 text-right text-xs tabular-nums text-amber-700">{s.applications || '—'}</td>
                            <td className="px-4 py-2.5 text-right text-xs tabular-nums text-rose-700">{s.balance || '—'}</td>
                          </tr>
                        ))
                    })()}
                  </tbody>
                </table>
                {companyRows.length === 0 && (
                  <p className="text-center text-sm text-slate-400 py-8">Нет данных за выбранный период</p>
                )}
              </div>
            </div>

            {/* Companies with activity but not registered in ob_accounting_companies */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-slate-800 text-sm">Активность без записи в реестре</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Компании из <code className="text-violet-600">accounting_activities</code>, которых нет в <code className="text-indigo-600">ob_accounting_companies</code>
                  </p>
                </div>
                <span className={`text-3xl font-bold ${orphanActivities.length > 0 ? 'text-rose-500' : 'text-slate-300'}`}>{orphanActivities.length}</span>
              </div>
              {orphanActivities.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <p className="text-3xl mb-2">✅</p>
                  <p className="text-sm font-medium">Все активные компании добавлены в реестр</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-200">
                        <th className="text-left px-5 py-3">#</th>
                        <th className="text-left px-4 py-3">Компания</th>
                        <th className="text-left px-4 py-3">Бухгалтер (из активности)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {orphanActivities.map((c, i) => (
                        <tr key={c.company_name} className="hover:bg-rose-50/30 transition-colors">
                          <td className="px-5 py-3 text-slate-400 font-mono text-xs">{i + 1}</td>
                          <td className="px-4 py-3 font-medium text-slate-800">{c.company_name}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">
                            <div className="flex items-center gap-1.5">
                              <Avatar name={c.accountant_name} />
                              {c.accountant_name}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4 — Comments */}
        {activeTab === 'comments' && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="font-semibold text-slate-800 text-sm">Ежедневные комментарии бухгалтеров</h2>
                <p className="text-xs text-slate-400 mt-0.5">Что сделано за день и что не учтено в таблице</p>
              </div>
              <button onClick={() => setShowModal(true)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">
                + Добавить комментарий
              </button>
            </div>
            {comments.length === 0 ? (
              <div className="text-center py-20 text-slate-400">
                <p className="text-4xl mb-3">💬</p>
                <p className="text-sm font-medium">Нет комментариев за выбранный период</p>
                <button onClick={() => setShowModal(true)}
                  className="mt-4 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700">
                  Добавить первый
                </button>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {comments.map(c => (
                  <div key={c.id} className="px-5 py-4 hover:bg-slate-50/50 transition-colors">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="text-xs font-semibold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-lg">{fmtDate(c.comment_date)}</span>
                      <div className="flex items-center gap-1.5">
                        <Avatar name={c.accountant_name} />
                        <span className="text-sm font-semibold text-slate-700">{c.accountant_name}</span>
                      </div>
                      {c.company_name && (
                        <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-lg font-medium">{c.company_name}</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed">{c.comment}</p>
                    {c.unaccounted_work && (
                      <div className="mt-2 flex gap-2 bg-amber-50 border-l-[3px] border-amber-400 rounded-r-xl px-3 py-2">
                        <span className="text-amber-500 mt-0.5 flex-shrink-0">⚠</span>
                        <div>
                          <p className="text-xs font-semibold text-amber-700 mb-0.5">Не учтено в таблице:</p>
                          <p className="text-xs text-amber-800">{c.unaccounted_work}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <footer className="text-center text-xs text-slate-400 pb-4">
          OB Accounting · {companies.length} компаний · {fmtDate(dateFrom)} — {fmtDate(dateTo)}
        </footer>
      </div>

      {showModal && (
        <AddCommentModal
          accountantNames={accountantList}
          companies={companies}
          access={access}
          canManage={canManage}
          onSave={handleAddComment}
          onClose={() => setShowModal(false)}
        />
      )}

      {detailModal && (
        <DocumentDetailModal
          params={detailModal}
          onClose={() => setDetailModal(null)}
        />
      )}
    </div>
  )
}
