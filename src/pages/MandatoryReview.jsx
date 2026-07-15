import { useCallback, useEffect, useState } from 'react'
import {
  fetchProblems,
  fetchChats,
  fetchAcknowledgements,
  fetchAppeals,
  acknowledgeProblem,
  submitAppeal,
} from '../lib/api'
import { DASHBOARD_SOURCES, formatDate } from '../lib/dashboard'
import { computeGate } from '../lib/ticketGate'
import { problemContext } from '../lib/presentation'
import { SOURCE_LABELS } from '../lib/constants'
import { Loading, ErrorMessage } from '../components/States'

// The mandatory review surface shown to a regular accountant while ANY of their
// yesterday tickets is unanswered. Nothing else in the app is reachable until
// every ticket here is accepted or appealed. When the last one is answered we
// re-check server-side and call onComplete() to unlock the platform.
export default function MandatoryReview({ access, onComplete }) {
  const [gate, setGate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [problems, chats, acks, appeals] = await Promise.all([
        // All Margarita/Sona rows for this accountant (any status, so answered
        // ones still count toward the total); scoping happens in computeGate.
        fetchProblems({ sourceIn: DASHBOARD_SOURCES }),
        fetchChats().catch(() => []),
        fetchAcknowledgements().catch(() => []),
        fetchAppeals().catch(() => []),
      ])
      const g = computeGate({ problems, chats, acks, appeals, access, now: new Date() })
      setGate(g)
      if (g.complete) onComplete()
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [access, onComplete])

  useEffect(() => {
    load()
  }, [load])

  if (loading && !gate) return <Loading />

  const total = gate?.total ?? 0
  const answered = gate?.answered ?? 0

  return (
    <div>
      <div className="alert" role="alert" style={{ marginBottom: 16 }}>
        <b>Перед началом работы необходимо обработать все тикеты за вчерашний день.</b>
        <div style={{ marginTop: 6 }}>
          Остальные разделы платформы недоступны, пока по каждому вчерашнему тикету
          вы не выберете <b>Принять</b> или <b>Подать апелляцию</b> с комментарием.
        </div>
      </div>

      <h1 className="page-title">Вчерашние тикеты</h1>
      <div className="queue-summary" aria-live="polite">
        Обработано <b>{answered}</b> из <b>{total}</b> тикетов
      </div>

      <ErrorMessage error={error} />

      {gate && gate.unanswered.length === 0 ? (
        <div className="queue-summary">Все тикеты обработаны. Открываем платформу…</div>
      ) : (
        (gate?.unanswered || []).map((t) => (
          <GateTicketCard
            key={t.problem_id}
            ticket={t}
            defaultName={access?.full_name}
            onAnswered={load}
          />
        ))
      )}
    </div>
  )
}

function GateTicketCard({ ticket, defaultName, onAnswered }) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(null) // null | 'appeal'
  const [error, setError] = useState(null)

  async function handleAccept() {
    setBusy(true)
    setError(null)
    try {
      await acknowledgeProblem({
        problemId: ticket.problem_id,
        accountantId: ticket.accountant_id,
        accountantName: ticket.accountant_name || defaultName,
      })
      await onAnswered()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  async function handleAppeal() {
    const text = comment.trim()
    if (!text) {
      setError(new Error('Комментарий обязателен для апелляции.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submitAppeal({
        problemId: ticket.problem_id,
        accountantId: ticket.accountant_id,
        accountantName: ticket.accountant_name || defaultName,
        comment: text,
      })
      await onAnswered()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  const context = problemContext(ticket)
  const detected = formatDate(ticket.detected_at)

  return (
    <div className={`card card-prio-${ticket.priority || 2}`}>
      <div className="card-head-line">
        <div className="head-left">
          <h3 className="card-title">
            {ticket.problem_title || ticket.problem_id}
            {ticket.client_name && (
              <span className="title-client">
                {' — '}
                {ticket.client_name}
                {ticket.contract_id && <span className="contract-id"> {ticket.contract_id}</span>}
              </span>
            )}
          </h3>
        </div>
        {ticket.chat_link && (
          <a className="head-right" href={ticket.chat_link} target="_blank" rel="noreferrer">
            Открыть ↗
          </a>
        )}
      </div>

      <div className="meta">
        {ticket.source && (
          <span>
            Источник: <b>{SOURCE_LABELS[ticket.source] || ticket.source}</b>
          </span>
        )}
        {ticket.accountant_name && (
          <span>
            Бухгалтер: <b>{ticket.accountant_name}</b>
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

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn btn-green" disabled={busy} onClick={handleAccept}>
          ✓ Принять
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => setMode((m) => (m === 'appeal' ? null : 'appeal'))}
        >
          Подать апелляцию
        </button>
      </div>

      {mode === 'appeal' && (
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <label>
            Причина несогласия <span className="required-star">*</span> — комментарий
            обязателен, апелляция уйдёт проверяющему
          </label>
          <textarea
            rows={3}
            placeholder="Объясните, почему вы не согласны с тикетом"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn" disabled={!comment.trim() || busy} onClick={handleAppeal}>
              {busy ? 'Отправка…' : 'Отправить апелляцию'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
