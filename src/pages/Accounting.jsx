import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../lib/AuthContext'
import { artyom, artyomConfigError } from '../lib/artyomClient'
import { supabase } from '../lib/supabaseClient'
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

  const fetchAll = useCallback(async () => {
    if (!artyom) return
    setLoading(true); setFetchError('')
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
                      <div className="px-5 py-2.5 bg-slate-50 flex items-center justify-between border-b border-slate-100">
                        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Активность по дням</span>
                        <span className="text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-full">итого: {totalActivityCount}</span>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-100">
                            <th className="text-left px-5 py-2">Дата</th>
                            <th className="text-left px-4 py-2">Бухгалтер</th>
                            <th className="text-left px-4 py-2">Система</th>
                            <th className="text-right px-5 py-2">Кол-во</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                          {acts.map(a => (
                            <tr key={a.id} className="hover:bg-indigo-50/20">
                              <td className="px-5 py-2.5 text-xs font-semibold text-slate-700 whitespace-nowrap">{fmtDate(a.activity_date)}</td>
                              <td className="px-4 py-2.5"><div className="flex items-center gap-1.5"><Avatar name={a.accountant_name} /><span className="text-xs text-slate-600">{a.accountant_name}</span></div></td>
                              <td className="px-4 py-2.5"><SourcePill src={a.system_source} /></td>
                              <td className="px-5 py-2.5 text-right"><span className="text-sm font-bold text-indigo-700 tabular-nums">{a[field] ?? 0}</span></td>
                            </tr>
                          ))}
                        </tbody>
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

function AddCommentModal({ employees, companies, access, canManage, onSave, onClose }) {
  const defaultName = canManage ? (employees[0]?.full_name ?? '') : (access?.full_name ?? '')
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
                {employees.map(e => <option key={e.id} value={e.full_name}>{e.full_name}</option>)}
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
  const [artemCompanies, setArtemComp] = useState([])
  const [activities, setActivities] = useState([])
  const [comments, setComments] = useState([])

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

  // For non-managers, force accountant filter to their own name
  const effectiveAccountant = canManage ? accountantFilter : (access?.full_name ?? 'all')

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
    const compQ = canManage
      ? artyom.from('ob_accounting_companies').select('id, company_name, contract_number, accountant_name, is_active, armsoft_company_id, tax_account_id').order('company_name')
      : artyom.from('ob_accounting_companies').select('id, company_name, contract_number, accountant_name, is_active, armsoft_company_id, tax_account_id').eq('accountant_name', access?.full_name ?? '').order('company_name')

    const empQ = supabase
      ? supabase.from('employees').select('id, full_name, role, is_active').in('role', ['accountant', 'head_accountant']).eq('is_active', true).order('full_name')
      : Promise.resolve({ data: [] })

    const artemQ = canManage
      ? artyom.from('artem_companies').select('id, company_name, contract_number, tin, is_active').order('company_name')
      : Promise.resolve({ data: [] })

    Promise.all([compQ, empQ, artemQ]).then(([{ data: comp }, { data: emp }, { data: artem }]) => {
      setCompanies(comp ?? [])
      // Deduplicate employees by full_name
      const seen = new Set()
      setEmployees((emp ?? []).filter(e => { if (seen.has(e.full_name)) return false; seen.add(e.full_name); return true }))
      setArtemComp(artem ?? [])
    }).finally(() => setLoadingStatic(false))
  }, [canManage, access?.full_name]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const missingCompanies = useMemo(() => {
    const ourNames = new Set(companies.map(c => c.company_name.trim().toLowerCase()))
    return artemCompanies.filter(c => !ourNames.has(c.company_name.trim().toLowerCase()))
  }, [companies, artemCompanies])

  const accountantList = useMemo(() => {
    const s = new Set()
    for (const c of companies) if (c.accountant_name) s.add(c.accountant_name)
    return Array.from(s).sort()
  }, [companies])

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

  const tabs = [
    ['companies', `По компаниям (${companyRows.length})`],
    ...(canManage ? [['missing', `⚠️ Не добавлены (${missingCompanies.length})`]] : []),
    ['comments', `💬 Комментарии (${comments.length})`],
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-4 space-y-6">

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-bold text-slate-800 mr-2">Отчётность бухгалтерии</span>

          {canManage && (
            <select value={accountantFilter} onChange={e => setAccountantFilter(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
              <option value="all">Все бухгалтеры</option>
              {accountantList.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          {!canManage && (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 bg-indigo-50 text-indigo-700 rounded-xl text-xs font-semibold">
              <Avatar name={access?.full_name ?? ''} />
              {access?.full_name}
            </span>
          )}

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
            <KpiCard label="Нет в бухгалтерии" value={missingCompanies.length} icon="⚠️" accent="bg-orange-50 text-orange-500"
              sub={`у Артёма ${artemCompanies.length} · у нас ${companies.length}`} />
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
              <div className="text-center py-20 text-slate-400">
                <p className="text-4xl mb-3">📭</p>
                <p className="text-sm font-medium">Нет данных за выбранный период</p>
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
                      const ctx = (sys) => ({
                        company_name: row.company_name,
                        accountant_name: row.accountant_name,
                        system_source: sys,
                        date_from: dateFrom,
                        date_to: dateTo,
                      })
                      return (
                        <tr key={row.company_name} className={`hover:bg-indigo-50/30 transition-colors ${i % 2 ? 'bg-slate-50/30' : ''}`}>
                          <td className="px-5 py-3 font-medium text-slate-800 whitespace-nowrap max-w-[220px]">
                            <span className="block truncate" title={row.company_name}>{row.company_name}</span>
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

        {/* TAB 2 — Missing companies (management only) */}
        {activeTab === 'missing' && canManage && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-slate-800 text-sm">Компании Артёма, которых нет в бухгалтерии</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Всего у Артёма: <strong>{artemCompanies.length}</strong> · В бухгалтерии: <strong>{companies.length}</strong> · Не добавлено: <strong className="text-rose-600">{missingCompanies.length}</strong>
                </p>
              </div>
              <span className="text-3xl font-bold text-rose-500">{missingCompanies.length}</span>
            </div>
            {missingCompanies.length === 0 ? (
              <div className="text-center py-20 text-slate-400">
                <p className="text-4xl mb-3">✅</p>
                <p className="text-sm font-medium">Все компании Артёма добавлены в бухгалтерию</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] text-slate-500 font-semibold uppercase tracking-wide border-b border-slate-200">
                      <th className="text-left px-5 py-3">#</th>
                      <th className="text-left px-4 py-3">Компания</th>
                      <th className="text-left px-4 py-3">Договор</th>
                      <th className="text-left px-4 py-3">ИНН</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {missingCompanies.map((c, i) => (
                      <tr key={c.id} className="hover:bg-rose-50/40 transition-colors">
                        <td className="px-5 py-3 text-slate-400 font-mono text-xs">{i + 1}</td>
                        <td className="px-4 py-3 font-medium text-slate-800">{c.company_name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.contract_number ?? '—'}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.tin ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 3 — Comments */}
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
          employees={employees}
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
