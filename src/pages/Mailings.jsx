import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  fetchCompanySettings,
  fetchMailingSchedule,
  fetchMailings,
  fetchManualAssets,
  fetchPlannedMailings,
  fetchSentNotifications,
  fetchPlannedMailingEdits,
  savePlannedMailing,
  saveManualAsset,
  signedAssetUrl,
} from '../lib/api'
import { classifyMailingStatus, normalizeContract, formatDate } from '../lib/dashboard'
import {
  expandSchedule,
  composeMailing,
  currentPeriod,
  periodLabel,
  monthName,
  autoSendWarning,
  formatDateTime,
  coveredMailingKeys,
  sendability,
  resolveLanguage,
} from '../lib/notifications'
import {
  CATEGORY_LABELS,
  MANUAL_ASSET_KINDS,
  MANUAL_ASSET_LABELS,
  TEMPLATE_LIST,
  manualAssetForCategory,
} from '../lib/templates'
import { useAuth } from '../lib/AuthContext'
import { Loading, ErrorMessage, Empty } from '../components/States'

const SENDABILITY_BADGE = {
  ready: { cls: 'badge-green', label: 'Готово к отправке' },
  awaiting_file: { cls: 'badge-amber', label: 'Ждёт файл' },
  covered: { cls: 'badge-gray', label: 'Уже отправлено / отмечено' },
}

// A stable "now" for the whole page render (avoids per-cell Date.now drift).
function useNow() {
  return useMemo(() => new Date(), [])
}

export default function Mailings() {
  const { access, canManage } = useAuth()
  const now = useNow()
  const period = currentPeriod(now)

  const [tab, setTab] = useState('planner')
  const [settings, setSettings] = useState([])
  const [schedule, setSchedule] = useState([])
  const [mailings, setMailings] = useState([])
  const [assets, setAssets] = useState([])
  const [planned, setPlanned] = useState([])
  const [sent, setSent] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      fetchCompanySettings().catch(() => []),
      fetchMailingSchedule().catch(() => []),
      fetchMailings().catch(() => []),
      fetchManualAssets({ period }).catch(() => []),
      fetchPlannedMailings({}).catch(() => []),
      fetchSentNotifications({}).catch(() => []),
    ])
      .then(([cs, sc, ml, as, pl, sn]) => {
        if (!alive) return
        setSettings(cs)
        setSchedule(sc)
        setMailings(ml)
        setAssets(as)
        setPlanned(pl)
        setSent(sn)
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [period, reloadKey])

  const refresh = () => setReloadKey((k) => k + 1)

  // Companies visible to this user: managers see all active; a regular
  // accountant sees only companies resolved to them (req 7 — never guess owner).
  const companies = useMemo(() => {
    const active = settings.filter((s) => s.active)
    if (canManage) return active
    const me = access?.employee_id
    return active.filter((s) => s.accountant_id && s.accountant_id === me)
  }, [settings, canManage, access])

  const coveredKeys = useMemo(
    () => coveredMailingKeys(mailings, classifyMailingStatus),
    [mailings],
  )

  if (loading) return <Loading />
  if (error) return <ErrorMessage error={error} />

  const TABS = [
    { key: 'planner', label: 'Планировщик (30 дней)' },
    { key: 'manual', label: 'Ручные вложения' },
    ...(canManage ? [{ key: 'byday', label: 'По дням (руководителю)' }] : []),
    { key: 'sent', label: 'Журнал отправленных' },
    { key: 'templates', label: 'Шаблоны' },
  ]

  return (
    <div>
      <h1 className="page-title">Рассылки</h1>
      <div className="alert" style={{ marginBottom: 12 }}>
        <b>Шаблонные уведомления отправляются только автоматически.</b> Вы можете заранее
        просмотреть и отредактировать текст, но <b>время отправки фиксировано</b> и меняется
        только по расписанию компании. Отправка сейчас на паузе (режим предпросмотра).
      </div>

      <div className="pills" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'btn' : 'btn-secondary'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'planner' && (
        <Planner
          companies={companies}
          schedule={schedule}
          planned={planned}
          assets={assets}
          coveredKeys={coveredKeys}
          period={period}
          now={now}
          onSaved={refresh}
        />
      )}
      {tab === 'manual' && (
        <ManualAssets
          companies={companies}
          assets={assets}
          period={period}
          uploadedBy={access?.full_name}
          onSaved={refresh}
        />
      )}
      {tab === 'byday' && <ByDay companies={companies} schedule={schedule} planned={planned} coveredKeys={coveredKeys} assets={assets} now={now} />}
      {tab === 'sent' && <SentLog sent={sent} companies={companies} canManage={canManage} />}
      {tab === 'templates' && <TemplatesInfo />}
    </div>
  )
}

// Build the concrete planned occurrences for one company for the next 30 days,
// merged with any persisted (edited) row so the accountant sees their edits.
function buildOccurrences({ company, schedule, planned, assets, coveredKeys, now }) {
  const rows = schedule.filter((s) => normalizeContract(s.agr_no) === normalizeContract(company.agr_no))
  const language = resolveLanguage({ storedLanguage: company.language, chatName: company.chat_name })
  const chain = expandSchedule(rows, { today: now, horizonDays: 30 })
  return chain.map((occ) => {
    // Each occurrence carries its OWN reporting period (the month it is sent
    // for, mqa 28th-cutoff) — a next-month occurrence must not be labelled or
    // deduped under the current period.
    const occPeriod = currentPeriod(occ.scheduledAt)
    const persisted = planned.find(
      (p) =>
        normalizeContract(p.agr_no) === normalizeContract(company.agr_no) &&
        p.category === occ.category &&
        p.subtype === occ.subtype &&
        p.period === occPeriod &&
        !p.is_test,
    )
    const auto = composeMailing({
      category: occ.category,
      subtype: occ.subtype,
      language,
      ctx: { period: occPeriod },
    })
    const text = persisted?.composed_text || auto || ''
    const state = sendability(
      { agrNo: company.agr_no, period: occPeriod, category: occ.category },
      { coveredKeys, assets },
    )
    return {
      ...occ,
      period: occPeriod,
      language,
      text,
      persisted,
      edited: !!persisted?.edited,
      state,
    }
  })
}

function Planner({ companies, schedule, planned, assets, coveredKeys, period, now, onSaved }) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState(null)

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? companies.filter(
          (c) =>
            (c.client_name || '').toLowerCase().includes(q) ||
            (c.chat_name || '').toLowerCase().includes(q) ||
            (c.agr_no || '').toLowerCase().includes(q),
        )
      : companies
    return list.slice(0, 100)
  }, [companies, filter])

  if (!companies.length) return <Empty text="Нет активных клиентов в вашей зоне." />

  return (
    <div>
      <input
        className="input"
        placeholder="Поиск по клиенту / чату / договору…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: 12, padding: 8, width: '100%', maxWidth: 420 }}
      />
      {companies.length > 100 && (
        <div className="empty" style={{ marginBottom: 8 }}>
          Показаны первые 100 из {companies.length}. Уточните поиск.
        </div>
      )}
      {visible.map((company) => {
        const occ = buildOccurrences({ company, schedule, planned, assets, coveredKeys, now })
        return (
          <div className="card" key={company.agr_no} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <b>{company.client_name || company.chat_name || company.agr_no}</b>{' '}
                <span style={{ color: 'var(--muted)' }}>· {company.agr_no}</span>
              </div>
              <span className="badge badge-gray">Язык: {company.language}</span>
            </div>
            {!occ.length && <div className="empty">Нет запланированных рассылок.</div>}
            {occ.map((o, i) => {
              const b = SENDABILITY_BADGE[o.state] || SENDABILITY_BADGE.ready
              return (
                <div key={i} style={{ borderTop: '1px solid var(--border, #eee)', paddingTop: 10, marginTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <b>{CATEGORY_LABELS[o.category]}</b>{' '}
                      <span style={{ color: 'var(--muted)' }}>· {o.subtype}</span>{' '}
                      <span className={`badge ${b.cls}`}>{b.label}</span>
                      {o.edited && <span className="badge badge-blue" style={{ marginLeft: 6 }}>изменено</span>}
                    </div>
                    <button className="btn-secondary" onClick={() => setEditing({ company, o })}>
                      Редактировать
                    </button>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--amber, #b26b00)', margin: '4px 0' }}>
                    {autoSendWarning(o.scheduledISO, o.language)}
                  </div>
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      background: 'var(--surface, #fafafa)',
                      padding: 10,
                      borderRadius: 6,
                      fontFamily: 'inherit',
                      fontSize: 13,
                      margin: 0,
                    }}
                  >
                    {o.text}
                  </pre>
                </div>
              )
            })}
          </div>
        )
      })}
      {editing && (
        <EditModal
          company={editing.company}
          occ={editing.o}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onSaved()
          }}
        />
      )}
    </div>
  )
}

function EditModal({ company, occ, onClose, onSaved }) {
  const [text, setText] = useState(occ.text)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [history, setHistory] = useState([])

  useEffect(() => {
    if (occ.persisted?.id) {
      fetchPlannedMailingEdits(occ.persisted.id).then(setHistory).catch(() => {})
    }
  }, [occ])

  async function onSave() {
    setSaving(true)
    setErr(null)
    try {
      await savePlannedMailing({
        agrNo: company.agr_no,
        category: occ.category,
        subtype: occ.subtype,
        period: occ.period,
        language: occ.language,
        scheduledAt: occ.scheduledISO,
        newText: text,
      })
      onSaved()
    } catch (e) {
      setErr(e)
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50,
      }}
      onClick={onClose}
    >
      <div className="card" style={{ maxWidth: 640, width: '100%', maxHeight: '90vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Редактировать сообщение</h2>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
          {company.client_name || company.agr_no} · {CATEGORY_LABELS[occ.category]}
        </div>
        <div className="alert" style={{ marginBottom: 8 }}>{autoSendWarning(occ.scheduledISO, occ.language)}</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8 }}
        />
        {err && <ErrorMessage error={err} />}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={onSave} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить изменение'}
          </button>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Отмена
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          Изменение логируется (кто и когда). Время отправки не изменяется.
        </p>
        {history.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <b style={{ fontSize: 13 }}>История изменений</b>
            {history.map((h) => (
              <div key={h.id} style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                {formatDateTime(h.edited_at)} — {h.edited_by}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ManualAssets({ companies, assets, period, uploadedBy, onSaved }) {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? companies.filter(
          (c) =>
            (c.client_name || '').toLowerCase().includes(q) ||
            (c.agr_no || '').toLowerCase().includes(q),
        )
      : companies
    return list.slice(0, 100)
  }, [companies, filter])

  function assetFor(agrNo, kind) {
    return assets.find(
      (a) => normalizeContract(a.agr_no) === normalizeContract(agrNo) && a.period === period && a.kind === kind,
    )
  }

  return (
    <div>
      <div className="alert" style={{ marginBottom: 12 }}>
        Раздел для ручных вложений за <b>{monthName(period, 'RU')} ({periodLabel(period)})</b>:
        ведомость по зарплате и отчёт/расчёт налогов. Прикрепите файл <b>или</b> отметьте «готово» —
        комментарий не обязателен.
      </div>
      <input
        className="input"
        placeholder="Поиск…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: 12, padding: 8, width: '100%', maxWidth: 420 }}
      />
      {visible.map((c) => (
        <div className="card" key={c.agr_no} style={{ marginBottom: 12 }}>
          <b>{c.client_name || c.chat_name || c.agr_no}</b>{' '}
          <span style={{ color: 'var(--muted)' }}>· {c.agr_no}</span>
          {MANUAL_ASSET_KINDS.map((kind) => (
            <AssetRow
              key={kind}
              agrNo={c.agr_no}
              kind={kind}
              period={period}
              asset={assetFor(c.agr_no, kind)}
              uploadedBy={uploadedBy}
              onSaved={onSaved}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function AssetRow({ agrNo, kind, period, asset, uploadedBy, onSaved }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ready = asset && (asset.marked_done || asset.storage_path)

  async function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      await saveManualAsset({ agrNo, period, kind, file, uploadedBy })
      onSaved()
    } catch (x) {
      setErr(x)
    } finally {
      setBusy(false)
    }
  }
  async function onMark() {
    setBusy(true)
    setErr(null)
    try {
      await saveManualAsset({ agrNo, period, kind, markedDone: true, uploadedBy })
      onSaved()
    } catch (x) {
      setErr(x)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border,#eee)', paddingTop: 8, marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span>
          {MANUAL_ASSET_LABELS[kind]}{' '}
          <span className={`badge ${ready ? 'badge-green' : 'badge-amber'}`}>
            {ready ? 'Готово' : 'Нужен файл / отметка'}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="btn-secondary" style={{ cursor: 'pointer' }}>
            {busy ? '…' : 'Прикрепить файл'}
            <input type="file" hidden onChange={onFile} disabled={busy} />
          </label>
          {!ready && (
            <button className="btn-secondary" onClick={onMark} disabled={busy}>
              Отметить «готово»
            </button>
          )}
        </span>
      </div>
      {asset?.file_name && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Файл:{' '}
          {asset.storage_path ? (
            <button
              className="link-btn"
              style={{ background: 'none', border: 0, color: 'var(--primary)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
              onClick={async () => {
                try {
                  const url = await signedAssetUrl(asset.storage_path)
                  if (url) window.open(url, '_blank', 'noopener')
                } catch (x) {
                  setErr(x)
                }
              }}
            >
              {asset.file_name}
            </button>
          ) : (
            asset.file_name
          )}
        </div>
      )}
      {err && <ErrorMessage error={err} />}
    </div>
  )
}

// Manager overview: everything going out, grouped by DAY (req 5).
function ByDay({ companies, schedule, planned, coveredKeys, assets, now }) {
  const byDay = useMemo(() => {
    const map = new Map()
    for (const company of companies) {
      const occ = buildOccurrences({ company, schedule, planned, assets, coveredKeys, now })
      for (const o of occ) {
        const day = formatDate(o.scheduledISO)
        if (!map.has(day)) map.set(day, [])
        map.get(day).push({ company, o })
      }
    }
    return [...map.entries()].sort((a, b) => a[1][0].o.scheduledAt - b[1][0].o.scheduledAt)
  }, [companies, schedule, planned, coveredKeys, assets, now])

  if (!byDay.length) return <Empty text="Нет запланированных рассылок." />

  return (
    <div>
      {byDay.map(([day, items]) => (
        <div className="card" key={day} style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>
            {day} <span style={{ color: 'var(--muted)' }}>· {items.length}</span>
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th>Клиент</th>
                <th>Тип</th>
                <th>Язык</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ company, o }, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border,#eee)' }}>
                  <td>{company.client_name || company.agr_no}</td>
                  <td>{CATEGORY_LABELS[o.category]}</td>
                  <td>{o.language}</td>
                  <td>
                    <span className={`badge ${(SENDABILITY_BADGE[o.state] || SENDABILITY_BADGE.ready).cls}`}>
                      {(SENDABILITY_BADGE[o.state] || SENDABILITY_BADGE.ready).label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function SentLog({ sent, companies, canManage }) {
  // A regular accountant must only see their own clients' sent mailings.
  const rows = useMemo(() => {
    if (canManage) return sent
    const owned = new Set(companies.map((c) => normalizeContract(c.agr_no)))
    return sent.filter((s) => owned.has(normalizeContract(s.agr_no)))
  }, [sent, companies, canManage])
  if (!rows.length) return <Empty text="Пока ничего не отправлено." />
  return (
    <div className="card">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
            <th>Дата</th>
            <th>Договор</th>
            <th>Клиент</th>
            <th>Тип</th>
            <th>Подтип</th>
            <th>Язык</th>
            <th>Текст</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} style={{ borderTop: '1px solid var(--border,#eee)' }}>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.sent_at)}</td>
              <td>{s.agr_no}</td>
              <td>{s.client_name}</td>
              <td>{CATEGORY_LABELS[s.category] || s.category}</td>
              <td>{s.subtype}</td>
              <td>{s.language}</td>
              <td style={{ maxWidth: 320 }}>
                <details>
                  <summary>{(s.text || '').slice(0, 60)}…</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{s.text}</pre>
                </details>
                {s.is_test && <span className="badge badge-gray">тест</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TemplatesInfo() {
  return (
    <div className="card">
      <p>
        Инвентарь шаблонов и классификация: <b>авто</b> — собирается автоматически;{' '}
        <b>ручное</b> — требует вложения бухгалтера (ведомость ЗП, отчёт налогов).
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
            <th>Категория</th>
            <th>Подтип</th>
            <th>Сборка</th>
            <th>Ручное вложение</th>
          </tr>
        </thead>
        <tbody>
          {TEMPLATE_LIST.map((t) => (
            <tr key={`${t.category}:${t.subtype}`} style={{ borderTop: '1px solid var(--border,#eee)' }}>
              <td>{CATEGORY_LABELS[t.category]}</td>
              <td>{t.label}</td>
              <td>
                <span className={`badge ${t.assembly === 'manual' ? 'badge-amber' : 'badge-green'}`}>
                  {t.assembly === 'manual' ? 'ручное' : t.assembly === 'mixed' ? 'авто + данные' : 'авто'}
                </span>
              </td>
              <td>{t.manualAsset ? MANUAL_ASSET_LABELS[t.manualAsset] : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
