import { useEffect, useRef, useState } from 'react'
import {
  fetchProblems,
  fetchFeedback,
  fetchReviewActions,
  submitReviewAction,
  rateProblem,
  fetchSonaComments,
  addSonaComment,
} from '../lib/api'
import { REVIEW_QUEUE, STATUS, STATUS_LABELS, VERDICT_LABELS } from '../lib/constants'
import { displayAuthor, sortQueue } from '../lib/presentation'
import { useAuth } from '../lib/AuthContext'
import StatusBadge from '../components/StatusBadge'
import { AttachmentList } from '../components/Attachments'
import ProblemMeta from '../components/ProblemMeta'
import { Loading, ErrorMessage, Empty } from '../components/States'

export default function Review() {
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showResolved, setShowResolved] = useState(false)
  // Also pull the live AI-detected items (status "waiting") so QA can rate
  // whether each was truly a problem — the false-positive feedback loop.
  const [showDetected, setShowDetected] = useState(false)
  // Monotonic request id so a slow, stale response can never overwrite a newer
  // one (e.g. toggling the checkbox quickly) and unmounted writes are dropped.
  const reqRef = useRef(0)

  function load() {
    const reqId = ++reqRef.current
    setLoading(true)
    setError(null)
    const statusIn = showResolved
      ? [...REVIEW_QUEUE, STATUS.fixed, STATUS.explained_accepted, STATUS.returned_to_accountant]
      : REVIEW_QUEUE
    const requests = [fetchProblems({ statusIn })]
    if (showDetected) {
      requests.push(fetchProblems({ source: 'ai', statusIn: [STATUS.waiting_for_accountant] }))
    }
    Promise.all(requests)
      .then(([base, detected = []]) => {
        if (reqId !== reqRef.current) return
        const byId = new Map()
        for (const p of [...base, ...detected]) byId.set(p.problem_id, p)
        setProblems([...byId.values()])
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
  }, [showResolved, showDetected])

  return (
    <div>
      <h1 className="page-title">Проверка</h1>
      <p className="page-subtitle">
        Отправленные бухгалтерами проблемы, а также оценка качества обнаружения ИИ.
      </p>

      <div className="toolbar">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Показывать закрытые / возвращённые
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={showDetected}
            onChange={(e) => setShowDetected(e.target.checked)}
          />
          Показывать обнаруженные ИИ (для оценки)
        </label>
      </div>

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : problems.length === 0 ? (
        <Empty text="Нет проблем на проверке." />
      ) : (
        sortQueue(problems).map((p) => (
          <ReviewCard key={p.problem_id} problem={p} onChanged={load} />
        ))
      )}
    </div>
  )
}

function ReviewCard({ problem, onChanged }) {
  const { access } = useAuth()
  const [feedback, setFeedback] = useState([])
  const [actions, setActions] = useState([])
  const [sonaComments, setSonaComments] = useState([])
  const [sonaDraft, setSonaDraft] = useState('')
  const [sonaPosting, setSonaPosting] = useState(false)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewerName, setReviewerName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingBusy, setRatingBusy] = useState(false)

  // Reviewer's truthiness verdict — feeds the false-positive learning loop.
  async function rate(isProblematic) {
    setRatingBusy(true)
    setError(null)
    try {
      await rateProblem({
        problemId: problem.problem_id,
        isProblematic,
        comment: ratingComment.trim(),
        ratedBy: access?.full_name || null,
        problemDetectedAt: problem.detected_at || null,
      })
      setRatingComment('')
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setRatingBusy(false)
    }
  }

  // Re-fetch when the status changes too, so that after an action the decision
  // history updates even while the card stays visible (resolved view).
  useEffect(() => {
    let ignore = false
    const requests = [fetchFeedback(problem.problem_id), fetchReviewActions(problem.problem_id)]
    if (problem.source === 'sona_review') {
      requests.push(fetchSonaComments(problem.problem_id))
    }
    Promise.all(requests)
      .then(([fb, ac, sc = []]) => {
        if (ignore) return
        setFeedback(fb)
        setActions(ac)
        setSonaComments(sc)
      })
      .catch((e) => !ignore && setError(e))
    return () => {
      ignore = true
    }
  }, [problem.problem_id, problem.status, problem.source])

  async function postSonaComment() {
    const body = sonaDraft.trim()
    if (!body) return
    setSonaPosting(true)
    try {
      await addSonaComment(problem.problem_id, body, access?.full_name || 'Проверяющий')
      setSonaDraft('')
      const updated = await fetchSonaComments(problem.problem_id)
      setSonaComments(updated)
    } catch (e) {
      setError(e)
    } finally {
      setSonaPosting(false)
    }
  }

  async function act(action) {
    if (action === STATUS.returned_to_accountant && reviewComment.trim() === '') {
      setError(new Error('Добавьте комментарий при возврате бухгалтеру.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submitReviewAction({
        problemId: problem.problem_id,
        reviewerName: reviewerName.trim(),
        action,
        reviewComment: reviewComment.trim(),
      })
      setReviewComment('')
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      // Always release the buttons — the card may stay mounted (resolved view).
      setBusy(false)
    }
  }

  const latestFeedback = feedback[0]

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{problem.problem_title || problem.problem_id}</h3>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusBadge status={problem.status} />
          {problem.verdict && (
            <span
              className={`badge ${problem.verdict === 'problematic' ? 'badge-green' : 'badge-gray'}`}
            >
              {VERDICT_LABELS[problem.verdict]}
            </span>
          )}
        </span>
      </div>

      <ProblemMeta problem={problem} />

      {problem.source === 'sona_review' && (
        <div className="subbox">
          <h4>Комментарии проверяющего</h4>
          {sonaComments.length === 0 && (
            <p className="hint" style={{ margin: '4px 0 8px' }}>Комментариев пока нет.</p>
          )}
          {sonaComments.map((c) => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              <span className="meta" style={{ fontSize: '0.8em' }}>
                <b>{displayAuthor(c.author)}</b> · {new Date(c.created_at).toLocaleString('ru-RU')}
              </span>
              <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{c.body}</p>
            </div>
          ))}
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <textarea
              rows={2}
              placeholder="Ответить…"
              value={sonaDraft}
              onChange={(e) => setSonaDraft(e.target.value)}
            />
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button
                className="btn btn-sm"
                disabled={!sonaDraft.trim() || sonaPosting}
                onClick={postSonaComment}
              >
                {sonaPosting ? 'Отправка…' : 'Отправить'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="subbox">
        <h4>Комментарий бухгалтера</h4>
        {!latestFeedback ? (
          <Empty text="Бухгалтер ещё не заполнил форму." />
        ) : (
          <>
            <div className="kv">
              <div className="k">Ситуация</div>
              <div className="v">{latestFeedback.situation_comment}</div>
            </div>
            <div className="kv">
              <div className="k">Решение</div>
              <div className="v">{latestFeedback.solution_comment}</div>
            </div>
            <div className="meta">
              <span>
                Автор: <b>{latestFeedback.accountant_name || '—'}</b>
              </span>
              <span>
                Отправлено: <b>{new Date(latestFeedback.submitted_at).toLocaleString('ru-RU')}</b>
              </span>
            </div>
          </>
        )}
        <AttachmentList problemId={problem.problem_id} />
      </div>

      {actions.length > 0 && (
        <div className="subbox">
          <h4>История решений</h4>
          {actions.map((a) => (
            <div className="kv" key={a.id}>
              <div className="k">
                {STATUS_LABELS[a.action] || a.action} ·{' '}
                {new Date(a.created_at).toLocaleString('ru-RU')}
                {a.reviewer_name ? ` · ${a.reviewer_name}` : ''}
              </div>
              {a.review_comment && <div className="v">{a.review_comment}</div>}
            </div>
          ))}
        </div>
      )}

      <ErrorMessage error={error} />

      <div className="subbox">
        <div className="field">
          <label>Имя проверяющего</label>
          <input
            placeholder="Напр. Руководитель"
            value={reviewerName}
            onChange={(e) => setReviewerName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Комментарий проверки (опционально, обязателен при возврате)</label>
          <textarea
            value={reviewComment}
            onChange={(e) => setReviewComment(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button className="btn btn-green" disabled={busy} onClick={() => act(STATUS.fixed)}>
            Отметить как исправлено
          </button>
          <button
            className="btn btn-green"
            disabled={busy}
            onClick={() => act(STATUS.explained_accepted)}
          >
            Объяснено / принято
          </button>
          <button
            className="btn btn-amber"
            disabled={busy}
            onClick={() => act(STATUS.returned_to_accountant)}
          >
            Вернуть бухгалтеру
          </button>
        </div>
      </div>

      <div className="subbox">
        <h4>Оценка качества обнаружения</h4>
        <p className="hint" style={{ marginTop: 0 }}>
          Это действительно была проблема? Ответ обучает ИИ точнее фильтровать чаты —
          помеченные «ложным срабатыванием» перестают появляться.
        </p>
        <div className="field">
          <label>Комментарий к оценке (необязательно)</label>
          <textarea
            placeholder="Почему это (не) проблема — поможет настроить обнаружение"
            value={ratingComment}
            onChange={(e) => setRatingComment(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button className="btn btn-green" disabled={ratingBusy} onClick={() => rate(true)}>
            Действительно проблема
          </button>
          <button className="btn btn-secondary" disabled={ratingBusy} onClick={() => rate(false)}>
            Ложное срабатывание
          </button>
        </div>
      </div>
    </div>
  )
}
