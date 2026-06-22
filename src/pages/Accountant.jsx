import { useEffect, useState } from 'react'
import { fetchProblems, fetchAccountants, submitAccountantFeedback } from '../lib/api'
import { ACCOUNTANT_ACTIONABLE } from '../lib/constants'
import { formatDate, problemContext } from '../lib/presentation'
import StatusBadge from '../components/StatusBadge'
import PriorityBadge from '../components/PriorityBadge'
import IdTip from '../components/IdTip'
import { Loading, ErrorMessage, Empty } from '../components/States'

export default function Accountant() {
  const [accountants, setAccountants] = useState([])
  const [accountantId, setAccountantId] = useState('')
  const [problems, setProblems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchAccountants()
      .then(setAccountants)
      .catch((e) => setError(e))
  }, [])

  function load() {
    setLoading(true)
    setError(null)
    fetchProblems({
      accountantId: accountantId || undefined,
      statusIn: ACCOUNTANT_ACTIONABLE,
    })
      .then(setProblems)
      .catch((e) => setError(e))
      .finally(() => setLoading(false))
  }

  useEffect(load, [accountantId])

  return (
    <div>
      <h1 className="page-title">Бухгалтер</h1>
      <p className="page-subtitle">
        Заполните комментарий по ситуации и решение для каждой назначенной проблемы.
      </p>

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

      <ErrorMessage error={error} />

      {loading ? (
        <Loading />
      ) : problems.length === 0 ? (
        <Empty text="Нет проблем, ожидающих заполнения." />
      ) : (
        problems.map((p) => (
          <ProblemFeedbackCard key={p.problem_id} problem={p} onSaved={load} />
        ))
      )}
    </div>
  )
}

function ProblemFeedbackCard({ problem, onSaved }) {
  const [situation, setSituation] = useState('')
  const [solution, setSolution] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const canSave = situation.trim() !== '' && solution.trim() !== '' && !saving

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
      setSaving(false)
    }
  }

  const context = problemContext(problem)
  const detected = formatDate(problem.detected_at)

  return (
    <div className="card">
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
          <PriorityBadge priority={problem.priority} />
          <StatusBadge status={problem.status} />
          <IdTip problemId={problem.problem_id} />
        </div>
        {problem.chat_link && (
          <a
            className="head-right"
            href={problem.chat_link}
            target="_blank"
            rel="noreferrer"
          >
            Открыть чат{problem.chat_name ? ` (${problem.chat_name})` : ''} ↗
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

      <div className="btn-row">
        <button className="btn" disabled={!canSave} onClick={handleSave}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        {!canSave && !saving && (
          <span className="hint">Оба поля обязательны для сохранения.</span>
        )}
      </div>
    </div>
  )
}
