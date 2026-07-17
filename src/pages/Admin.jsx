import { useEffect, useMemo, useState } from 'react'
import { fetchProblems, createProblem } from '../lib/api'
import { SOURCES, SOURCE_LABELS } from '../lib/constants'
import { CATEGORY, CATEGORY_LABELS, CATEGORY_FILTERS, categoryOf, matchesCategory } from '../lib/dashboard'
import StatusBadge from '../components/StatusBadge'
import { Loading, ErrorMessage, Empty } from '../components/States'

// Category options for the Admin table. Admin lists every source (incl. the
// historical `ai` / manual rows), so it also offers the «Прочее» bucket that
// the accountant-facing filters never need.
const ADMIN_CATEGORY_FILTERS = [
  ...CATEGORY_FILTERS,
  { key: CATEGORY.other, label: CATEGORY_LABELS.other },
]

const emptyForm = {
  problem_id: '',
  source: 'manual',
  client_name: '',
  contract_id: '',
  chat_name: '',
  chat_link: '',
  accountant_name: '',
  accountant_id: '',
  priority: 2,
  problem_title: '',
  problem_description: '',
  ai_comment: '',
}

function suggestProblemId() {
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `KK-${new Date().getFullYear()}-${rnd}`
}

export default function Admin() {
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Filters for the "all problems" table (Admin only): by accountant and by
  // category, so management can find a ticket without scanning the whole list.
  const [filterAccountant, setFilterAccountant] = useState('')
  const [filterCategory, setFilterCategory] = useState('all')

  const [form, setForm] = useState({ ...emptyForm, problem_id: suggestProblemId() })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [success, setSuccess] = useState(null)

  function load() {
    setLoading(true)
    fetchProblems()
      .then(setProblems)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    setSuccess(null)
    try {
      const payload = {
        ...form,
        priority: Number(form.priority) || 2,
        detected_at: new Date().toISOString(),
      }
      // Drop empty strings so they store as NULL.
      for (const k of Object.keys(payload)) {
        if (payload[k] === '') payload[k] = null
      }
      const created = await createProblem(payload)
      setSuccess(`Проблема ${created.problem_id} создана.`)
      setForm({ ...emptyForm, problem_id: suggestProblemId() })
      load()
    } catch (e2) {
      setFormError(e2)
    } finally {
      setSaving(false)
    }
  }

  const canCreate =
    form.problem_id.trim() !== '' && form.source !== '' && !saving

  // Distinct accountants present in the data, for the filter dropdown. Keyed by
  // the resolved id; rows without one are grouped under a single «не определён».
  const accountantOptions = useMemo(() => {
    const map = new Map()
    for (const p of problems) {
      const id = p.accountant_id || ''
      if (!map.has(id)) map.set(id, p.accountant_name || (id ? id : 'не определён'))
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [problems])

  const filtered = useMemo(
    () =>
      problems.filter((p) => {
        if (filterAccountant !== '' && (p.accountant_id || '') !== filterAccountant) return false
        if (!matchesCategory(p, filterCategory)) return false
        return true
      }),
    [problems, filterAccountant, filterCategory],
  )

  return (
    <div>
      <h1 className="page-title">Админ</h1>
      <p className="page-subtitle">Создание тестовой проблемы и просмотр всех записей.</p>

      <div className="card">
        <h3 className="card-title" style={{ marginBottom: 14 }}>
          Создать проблему
        </h3>

        {success && <div className="notice">{success}</div>}
        <ErrorMessage error={formError} />

        <form onSubmit={handleCreate}>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <div className="field">
              <label>
                problem_id <span className="required-star">*</span>
              </label>
              <input value={form.problem_id} onChange={set('problem_id')} />
            </div>
            <div className="field">
              <label>Источник</label>
              <select value={form.source} onChange={set('source')}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Приоритет</label>
              <select value={form.priority} onChange={set('priority')}>
                <option value={1}>1 — Высокий</option>
                <option value={2}>2 — Средний</option>
                <option value={3}>3 — Низкий</option>
              </select>
            </div>
          </div>

          <div className="toolbar" style={{ marginBottom: 0 }}>
            <div className="field">
              <label>Клиент</label>
              <input value={form.client_name} onChange={set('client_name')} />
            </div>
            <div className="field">
              <label>contract_id</label>
              <input value={form.contract_id} onChange={set('contract_id')} />
            </div>
          </div>

          <div className="toolbar" style={{ marginBottom: 0 }}>
            <div className="field">
              <label>Имя бухгалтера</label>
              <input value={form.accountant_name} onChange={set('accountant_name')} />
            </div>
            <div className="field">
              <label>accountant_id</label>
              <input value={form.accountant_id} onChange={set('accountant_id')} />
            </div>
          </div>

          <div className="toolbar" style={{ marginBottom: 0 }}>
            <div className="field">
              <label>Название чата</label>
              <input value={form.chat_name} onChange={set('chat_name')} />
            </div>
            <div className="field">
              <label>Ссылка на чат</label>
              <input value={form.chat_link} onChange={set('chat_link')} />
            </div>
          </div>

          <div className="field">
            <label>Заголовок проблемы</label>
            <input value={form.problem_title} onChange={set('problem_title')} />
          </div>
          <div className="field">
            <label>Описание проблемы</label>
            <textarea value={form.problem_description} onChange={set('problem_description')} />
          </div>
          <div className="field">
            <label>Комментарий AI / проверки</label>
            <textarea value={form.ai_comment} onChange={set('ai_comment')} />
          </div>

          <div className="btn-row">
            <button className="btn" type="submit" disabled={!canCreate}>
              {saving ? 'Создание…' : 'Создать проблему'}
            </button>
          </div>
        </form>
      </div>

      <h3 className="card-title" style={{ margin: '8px 0 12px' }}>
        Все проблемы ({filtered.length} из {problems.length})
      </h3>

      {/* Filter tickets by accountant and by category. */}
      <div className="toolbar">
        <div className="field">
          <label>Бухгалтер</label>
          <select value={filterAccountant} onChange={(e) => setFilterAccountant(e.target.value)}>
            <option value="">Все бухгалтеры</option>
            {accountantOptions.map((a) => (
              <option key={a.id || 'none'} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Категория</label>
          <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
            {ADMIN_CATEGORY_FILTERS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ErrorMessage error={error} />
      {loading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>problem_id</th>
                <th>Клиент</th>
                <th>Источник</th>
                <th>Категория</th>
                <th>Приоритет</th>
                <th>Бухгалтер</th>
                <th>Статус</th>
                <th>Создано</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.problem_id}>
                  <td>{p.problem_id}</td>
                  <td>{p.client_name || '—'}</td>
                  <td>{SOURCE_LABELS[p.source] || p.source}</td>
                  <td>{CATEGORY_LABELS[categoryOf(p)] || '—'}</td>
                  <td>{p.priority}</td>
                  <td>{p.accountant_name || '—'}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>{new Date(p.created_at).toLocaleDateString('ru-RU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
