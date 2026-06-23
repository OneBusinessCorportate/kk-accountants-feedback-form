import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchProblems, fetchAccountants, submitAccountantFeedback, fetchComments, submitComment } from '../lib/api'
import { ACCOUNTANT_ACTIONABLE } from '../lib/constants'
import {
  formatDate,
  isOverdue,
  problemContext,
  sortQueue,
} from '../lib/presentation'
import { Loading, ErrorMessage, Empty } from '../components/States'
import { useAuth } from '../lib/AuthContext'
import { keepOwnProblems } from '../lib/scope'

export default function Accountant() {
  const { access, isSupervisor } = useAuth()
  const [accountants, setAccountants] = useState([])
  const [accountantId, setAccountantId] = useState('')
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Monotonic request id so changing the accountant filter quickly can't let a
  // stale response overwrite a newer one, and unmounted writes are dropped.
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
  }, [accountantId, isSupervisor, access])

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

function ProblemFeedbackCard({ problem, onSaved }) {
  const { access } = useAuth()
  const [situation, setSituation] = useState('')
  const [solution, setSolution] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [commentSaving, setCommentSaving] = useState(false)

  const canSave = situation.trim() !== '' && solution.trim() !== '' && !saving
  // Only nudge once the accountant has started but left one field empty — a
  // fresh, untouched card stays clean.
  const showRequiredHint =
    !saving && !canSave && (situation.trim() !== '' || solution.trim() !== '')

  useEffect(() => {
    fetchComments(problem.problem_id)
      .then(setComments)
      .catch((e) => setError(e))
  }, [problem.problem_id])

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
      onSaved()
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  async function handleCommentSave() {
    setCommentSaving(true)
    setError(null)
    try {
      await submitComment({
        problemId: problem.problem_id,
        accountantId: problem.accountant_id,
        accountantName: problem.accountant_name || access?.full_name,
        commentText: newComment.trim(),
      })
      setNewComment('')
      const updated = await fetchComments(problem.problem_id)
      setComments(updated)
    } catch (e) {
      setError(e)
    } finally {
      setCommentSaving(false)
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

      {comments.length > 0 && (
        <div className="subbox">
          <h4>Комментарии администратора</h4>
          {comments.map((c) => (
            <div className="kv" key={c.id}>
              <div className="k">
                {new Date(c.created_at).toLocaleString('ru-RU')}
              </div>
              <div className="v">{c.comment_text}</div>
            </div>
          ))}
        </div>
      )}

      <div className="field">
        <label>Добавить комментарий</label>
        <textarea
          placeholder="Ваш комментарий (видно администратору)"
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
        />
      </div>

      <div className="btn-row">
        <button className="btn" disabled={!canSave} onClick={handleSave}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button className="btn btn-secondary" disabled={commentSaving || !newComment.trim()} onClick={handleCommentSave}>
          {commentSaving ? 'Отправка…' : 'Отправить комментарий'}
        </button>
        {showRequiredHint && (
          <span className="hint">Оба поля обязательны для сохранения.</span>
        )}
      </div>
    </div>
  )
}
