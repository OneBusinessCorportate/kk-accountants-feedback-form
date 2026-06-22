import { useEffect, useState } from 'react'
import {
  fetchProblems,
  fetchFeedback,
  fetchReviewActions,
  submitReviewAction,
} from '../lib/api'
import { REVIEW_QUEUE, STATUS, STATUS_LABELS } from '../lib/constants'
import { sortQueue } from '../lib/presentation'
import StatusBadge from '../components/StatusBadge'
import ProblemMeta from '../components/ProblemMeta'
import { Loading, ErrorMessage, Empty } from '../components/States'

export default function Review() {
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showResolved, setShowResolved] = useState(false)

  function load() {
    setLoading(true)
    setError(null)
    const statusIn = showResolved
      ? [...REVIEW_QUEUE, STATUS.fixed, STATUS.explained_accepted, STATUS.returned_to_accountant]
      : REVIEW_QUEUE
    fetchProblems({ statusIn })
      .then(setProblems)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }

  useEffect(load, [showResolved])

  return (
    <div>
      <h1 className="page-title">Проверка</h1>
      <p className="page-subtitle">
        Отправленные бухгалтерами проблемы с комментариями и решениями.
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
  const [feedback, setFeedback] = useState([])
  const [actions, setActions] = useState([])
  const [reviewComment, setReviewComment] = useState('')
  const [reviewerName, setReviewerName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([fetchFeedback(problem.problem_id), fetchReviewActions(problem.problem_id)])
      .then(([fb, ac]) => {
        setFeedback(fb)
        setActions(ac)
      })
      .catch((e) => setError(e))
  }, [problem.problem_id])

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
      onChanged()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  const latestFeedback = feedback[0]

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{problem.problem_title || problem.problem_id}</h3>
        <StatusBadge status={problem.status} />
      </div>

      <ProblemMeta problem={problem} />

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
    </div>
  )
}
