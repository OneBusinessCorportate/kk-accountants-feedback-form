import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchProblems, fetchAccountants, submitAccountantFeedback, fetchSonaComments, addSonaComment, uploadFeedbackAttachment } from '../lib/api'
import { AttachmentList, AttachmentPicker } from '../components/Attachments'
import { ACCOUNTANT_ACTIONABLE, SOURCE_LABELS } from '../lib/constants'
import {
  displayAuthor,
  formatDate,
  isOverdue,
  problemContext,
  sortQueue,
} from '../lib/presentation'
import { Loading, ErrorMessage, Empty } from '../components/States'
import { useAuth } from '../lib/AuthContext'
import { keepOwnProblems } from '../lib/scope'

const PERIODS = [
  { key: 'today', label: 'Сегодня' },
  { key: '1d',    label: 'Вчера' },
  { key: '2d',    label: '2 дня' },
  { key: '7d',    label: 'Неделя' },
  { key: 'all',   label: 'Всё время' },
]

function sinceForPeriod(key) {
  if (key === 'all') return undefined
  if (key === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  const days = key === '1d' ? 1 : key === '2d' ? 2 : 7
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

export default function Accountant() {
  const { access, isSupervisor } = useAuth()
  const [accountants, setAccountants] = useState([])
  const [accountantId, setAccountantId] = useState('')
  const [period, setPeriod] = useState('2d')
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Monotonic request id so changing filters quickly can't let a stale
  // response overwrite a newer one, and unmounted writes are dropped.
  const reqRef = useRef(0)

  // Only supervisors get the "filter by accountant" picker; a regular
  // accountant is always locked to their own queue.
  useEffect(() => {
    if (!isSupervisor) return
    fetchAccountants()
      .then(setAccountants)
      .catch((e) => setError(e))
  }, [isSupervisor])

  function load() {
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    fetchProblems({
      // Supervisors may filter server-side; scoped accountants fetch all
      // actionable rows and are narrowed to their own client-side.
      accountantId: isSupervisor ? accountantId || undefined : undefined,
      statusIn: ACCOUNTANT_ACTIONABLE,
      since: sinceForPeriod(period),
    })
      .then((data) => {
        if (reqId !== reqRef.current) return
        // Drop problems a reviewer judged a false positive — they're not real work.
        const visible = data.filter((p) => p.verdict !== 'not_problematic')
        setProblems(isSupervisor ? visible : keepOwnProblems(visible, access))
      })
      .catch((e) => reqId === reqRef.current && setError(e))
      .finally(() => reqId === reqRef.current && setLoading(false))
  }

  useEffect(() => {
    load()
    // Invalidate any in-flight request on unmount / before the next load.
    return () => {
      reqRef.current++
    }
  }, [accountantId, period, isSupervisor, access])

  // Most urgent / longest-waiting first, and count what's overdue.
  const ordered = useMemo(() => sortQueue(problems), [problems])
  const overdueCount = useMemo(
    () => problems.filter((p) => isOverdue(p)).length,
    [problems],
  )

  return (
    <div>
      <h1 className="page-title">Бухгалтер</h1>
      <p className="page-subtitle">
        Заполните комментарий по ситуации и решение для каждой назначенной проблемы.
      </p>

      {isSupervisor ? (
        <div className="toolbar">
          <div className="field">
            <label>Фильтр по бухгалтеру</label>
            <select value={accountantId} onChange={(e) => setAccountantId(e.target.value)}>
              <option value="">Все бухгалтеры</option>
              {accountants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        <div className="queue-summary">
          Показаны проблемы, назначенные вам: <b>{access?.full_name}</b>
        </div>
      )}

      <div className="period-pills">
        {PERIODS.map(({ key, label }) => (
          <button
            key={key}
            className={`btn btn-sm ${period === key ? '' : 'btn-secondary'}`}
            onClick={() => setPeriod(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : problems.length === 0 ? (
        <Empty text="Нет проблем, ожидающих заполнения." />
      ) : (
        <>
          <div className="queue-summary">
            В очереди: <b>{problems.length}</b>
            {overdueCount > 0 && (
              <span className="badge badge-red">Просрочено: {overdueCount}</span>
            )}
          </div>
          {ordered.map((p) => (
            <ProblemFeedbackCard key={p.problem_id} problem={p} onSaved={load} />
          ))}
        </>
      )}
    </div>
  )
}

// Shared thread with the QA platform: accountants and supervisors can both
// write here; everything posted is visible on the checker's side too.
function SonaComments({ problem, authorName }) {
  const [comments, setComments] = useState([])
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    fetchSonaComments(problem.problem_id).then(setComments).catch(() => {})
  }, [problem.problem_id])

  async function handlePost() {
    const body = draft.trim()
    if (!body) return
    setPosting(true)
    try {
      await addSonaComment(problem.problem_id, body, authorName || 'Бухгалтер')
      setDraft('')
      const updated = await fetchSonaComments(problem.problem_id)
      setComments(updated)
    } finally {
      setPosting(false)
    }
  }

  return (
    <div className="subbox" style={{ marginBottom: 12 }}>
      <h4 style={{ marginTop: 0 }}>Комментарии по проверке</h4>
      {comments.length === 0 && (
        <p className="hint" style={{ margin: '4px 0 8px' }}>
          Комментариев пока нет. Можно задать вопрос или уточнить детали — проверяющий увидит.
        </p>
      )}
      {comments.map((c) => (
        <div key={c.id} style={{ marginBottom: 8 }}>
          <span className="meta" style={{ fontSize: '0.8em' }}>
            <b>{displayAuthor(c.author)}</b> · {formatDate(c.created_at)}
          </span>
          <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{c.body}</p>
        </div>
      ))}
      <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <textarea
            rows={2}
            placeholder="Написать комментарий…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button
              className="btn btn-sm"
              disabled={!draft.trim() || posting}
              onClick={handlePost}
            >
              {posting ? 'Отправка…' : 'Отправить'}
            </button>
          </div>
        </div>
    </div>
  )
}

function ProblemFeedbackCard({ problem, onSaved }) {
  const { access, isSupervisor } = useAuth()
  const [situation, setSituation] = useState('')
  const [solution, setSolution] = useState('')
  const [files, setFiles] = useState([])
  const [attachRefresh, setAttachRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const canSave = situation.trim() !== '' && solution.trim() !== '' && !saving
  // Only nudge once the accountant has started but left one field empty — a
  // fresh, untouched card stays clean.
  const showRequiredHint =
    !saving && !canSave && (situation.trim() !== '' || solution.trim() !== '')

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await submitAccountantFeedback({
        problemId: problem.problem_id,
        accountantId: problem.accountant_id,
        accountantName: problem.accountant_name,
        situationComment: situation.trim(),
        solutionComment: solution.trim(),
      })
      // Attachments are optional; the feedback above is already saved, so an
      // upload failure is reported without losing the submitted answer.
      const failed = []
      for (const file of files) {
        try {
          await uploadFeedbackAttachment({
            problemId: problem.problem_id,
            file,
            uploadedBy: access?.full_name || problem.accountant_name || null,
          })
        } catch {
          failed.push(file.name)
        }
      }
      setFiles([])
      setAttachRefresh((n) => n + 1)
      if (failed.length) {
        setError(new Error(`Ответ сохранён, но не удалось загрузить: ${failed.join(', ')}`))
        return
      }
      onSaved()
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  const context = problemContext(problem)
  const detected = formatDate(problem.detected_at)

  return (
    <div className={`card card-prio-${problem.priority || 2}`}>
      <div className="card-head-line">
        <div className="head-left">
          <h3 className="card-title">
            {problem.problem_title || problem.problem_id}
            {problem.client_name && (
              <span className="title-client">
                {' — '}
                {problem.client_name}
                {problem.contract_id && (
                  <span className="contract-id"> {problem.contract_id}</span>
                )}
              </span>
            )}
          </h3>
        </div>
        {problem.chat_link && (
          <a
            className="head-right"
            href={problem.chat_link}
            target="_blank"
            rel="noreferrer"
          >
            Открыть ↗
          </a>
        )}
      </div>

      <div className="meta">
        {problem.source && (
          <span>
            Источник: <b>{SOURCE_LABELS[problem.source] || problem.source}</b>
          </span>
        )}
        {problem.accountant_name && (
          <span>
            Бухгалтер: <b>{problem.accountant_name}</b>
          </span>
        )}
        {detected && (
          <span>
            Обнаружено: <b>{detected}</b>
          </span>
        )}
      </div>

      {context && <div className="description">{context}</div>}

      {problem.source === 'sona_review' && (
        <SonaComments problem={problem} authorName={access?.full_name} />
      )}

      <ErrorMessage error={error} />

      <div className="field">
        <label>
          Комментарий по ситуации <span className="required-star">*</span>
        </label>
        <textarea
          placeholder="Что произошло и почему появилась проблема"
          value={situation}
          onChange={(e) => setSituation(e.target.value)}
        />
      </div>

      <div className="field">
        <label>
          Решение <span className="required-star">*</span>
        </label>
        <textarea
          placeholder="Что будет сделано, чтобы устранить ситуацию или избежать повторения"
          value={solution}
          onChange={(e) => setSolution(e.target.value)}
        />
      </div>

      <AttachmentList problemId={problem.problem_id} refreshKey={attachRefresh} />
      <AttachmentPicker files={files} onFiles={setFiles} disabled={saving} />

      <div className="btn-row">
        <button className="btn" disabled={!canSave} onClick={handleSave}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        {showRequiredHint && (
          <span className="hint">Оба поля обязательны для сохранения.</span>
        )}
      </div>
    </div>
  )
}
