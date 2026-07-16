import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchProblems, fetchChats, fetchAccountants, submitAccountantFeedback, fetchSonaComments, addSonaComment, uploadFeedbackAttachment, acknowledgeProblem, submitAppeal, fetchAppealsForProblem, fetchAppeals, fetchViolationWorkflowForProblem, acknowledgeViolation, appealViolation } from '../lib/api'
import { AttachmentList, AttachmentPicker } from '../components/Attachments'
import { ACCOUNTANT_ACTIONABLE, SOURCE_LABELS, APPEAL_STATUS_LABELS, APPEAL_STATUS_BADGE } from '../lib/constants'
import { isMargaritaProblem, interpretWorkflow } from '../lib/violationWorkflow'
import { displayAuthor, problemContext, sortQueue } from '../lib/presentation'
import {
  DASHBOARD_SOURCES,
  PERIODS,
  prepareDashboard,
  formatDate,
  isOverdue,
} from '../lib/dashboard'
import { Loading, ErrorMessage, Empty } from '../components/States'
import { useAuth } from '../lib/AuthContext'
import { keepOwnProblems } from '../lib/scope'

export default function Accountant() {
  const { access, isSupervisor } = useAuth()
  const [accountants, setAccountants] = useState([])
  const [accountantId, setAccountantId] = useState('')
  const [period, setPeriod] = useState('week')
  const [problems, setProblems] = useState([])
  const [myAppeals, setMyAppeals] = useState([])
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
    // Only Margarita/Sona reviews (never AI), only actionable statuses. The
    // chat directory lets us drop problems on inactive/unknown chats.
    Promise.all([
      fetchProblems({
        // Supervisors may filter server-side by accountant; a scoped accountant
        // fetches all and is narrowed client-side (matches uuid AND name).
        accountantId: isSupervisor ? accountantId || undefined : undefined,
        statusIn: ACCOUNTANT_ACTIONABLE,
        sourceIn: DASHBOARD_SOURCES,
      }),
      fetchChats().catch(() => []),
      // The accountant's own appeals (any status) — shown as a compact tracker
      // so they can follow a decision even after the issue leaves the queue.
      isSupervisor ? Promise.resolve([]) : fetchAppeals().catch(() => []),
    ])
      .then(([data, chats, appeals]) => {
        if (reqId !== reqRef.current) return
        // prepareDashboard drops AI/false-positives/inactive chats, filters the
        // period and keeps only rows with a resolved accountant.
        const { active } = prepareDashboard({ problems: data, chats, period, now: new Date() })
        setProblems(isSupervisor ? active : keepOwnProblems(active, access))
        setMyAppeals(isSupervisor ? [] : keepOwnProblems(appeals, access))
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

      {!isSupervisor && myAppeals.length > 0 && <MyAppeals appeals={myAppeals} />}

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

// Compact tracker of the accountant's own appeals so they can follow a decision
// after the issue has left the actionable queue. The reviewer's name is never
// shown (only the decision + their optional comment).
function MyAppeals({ appeals }) {
  return (
    <div className="subbox" style={{ marginBottom: 16 }}>
      <h4 style={{ marginTop: 0 }}>Мои апелляции</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Проблема</th>
              <th>Дата</th>
              <th>Статус</th>
              <th>Комментарий проверяющего</th>
            </tr>
          </thead>
          <tbody>
            {appeals.map((a) => (
              <tr key={a.id}>
                <td style={{ maxWidth: 260, whiteSpace: 'normal' }}>{a.problem_title || a.problem_id}</td>
                <td>{formatDate(a.created_at)}</td>
                <td>
                  <span className={`badge ${APPEAL_STATUS_BADGE[a.status] || 'badge-gray'}`}>
                    {APPEAL_STATUS_LABELS[a.status] || a.status}
                  </span>
                </td>
                <td style={{ maxWidth: 260, whiteSpace: 'normal', color: 'var(--muted)' }}>
                  {a.resolution_comment || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// The two required accountant reactions on every QA issue (req 3):
//   «Ознакомлен»       — acknowledge & accept
//   «Подать апелляцию» — dispute with a short comment
// A pending appeal disables both actions; a resolved appeal shows the decision.
function ReactionBox({ problem, onDone }) {
  const { access } = useAuth()
  const [appeals, setAppeals] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchAppealsForProblem(problem.problem_id)
      .then((rows) => setAppeals(rows))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [problem.problem_id])

  const pending = appeals.find((a) => a.status === 'pending')
  const lastResolved = appeals.find((a) => a.status !== 'pending')

  async function handleAcknowledge() {
    setBusy(true)
    setError(null)
    try {
      await acknowledgeProblem({
        problemId: problem.problem_id,
        accountantId: problem.accountant_id,
        accountantName: problem.accountant_name || access?.full_name,
      })
      onDone()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  async function handleAppeal() {
    const text = comment.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      await submitAppeal({
        problemId: problem.problem_id,
        accountantId: problem.accountant_id,
        accountantName: problem.accountant_name || access?.full_name,
        comment: text,
      })
      onDone()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="subbox" style={{ marginBottom: 12 }}>
      <h4 style={{ marginTop: 0 }}>Ваша реакция</h4>

      {lastResolved && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Предыдущая апелляция:{' '}
          <span className={`badge ${APPEAL_STATUS_BADGE[lastResolved.status] || 'badge-gray'}`}>
            {APPEAL_STATUS_LABELS[lastResolved.status] || lastResolved.status}
          </span>
          {lastResolved.resolution_comment ? ` — «${lastResolved.resolution_comment}»` : ''}
        </p>
      )}

      <ErrorMessage error={error} />

      {pending ? (
        <p className="hint" style={{ margin: 0 }}>
          Апелляция отправлена и ожидает решения проверяющего.
        </p>
      ) : (
        <>
          <div className="btn-row" style={{ marginBottom: 10 }}>
            <button className="btn btn-green" disabled={busy} onClick={handleAcknowledge}>
              ✓ Ознакомлен (согласен)
            </button>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>
              Не согласны? Напишите комментарий — после «Сохранить» апелляция уйдёт
              проверяющему (Маргарите) на рассмотрение
            </label>
            <textarea
              rows={3}
              placeholder="Ваш комментарий / причина несогласия с проблемой"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button className="btn" disabled={!comment.trim() || busy} onClick={handleAppeal}>
                {busy ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Reaction on a Margarita violation. Unlike the generic ReactionBox (which uses
// this app's kk_problem_* tables), this one persists straight into the QA
// platform's OWN tables (mqa_violations / mqa_violation_appeals) via the
// migration-0027 RPCs, and reads Margarita's live status + decision from the
// kk_violation_workflow view — so she sees the reaction and the accountant sees
// her verdict. The login code is enforced server-side; ownership is not trusted
// from the client.
function MargaritaReactionBox({ problem, onDone }) {
  const [row, setRow] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  function reload() {
    return fetchViolationWorkflowForProblem(problem.problem_id)
      .then((r) => setRow(r))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }

  useEffect(() => {
    setLoaded(false)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem.problem_id])

  const wf = interpretWorkflow(row)

  async function handleAcknowledge() {
    setBusy(true)
    setError(null)
    try {
      await acknowledgeViolation({ problemId: problem.problem_id })
      await reload()
      onDone()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  async function handleAppeal() {
    const text = comment.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      await appealViolation({ problemId: problem.problem_id, appealText: text })
      setComment('')
      await reload()
      onDone()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="subbox" style={{ marginBottom: 12 }}>
      <h4 style={{ marginTop: 0 }}>Ваша реакция</h4>

      <p className="hint" style={{ margin: '0 0 8px' }}>
        Статус:{' '}
        <span className={`badge ${wf.badge}`}>{wf.label}</span>
      </p>

      {wf.pendingAppeal && wf.appealText && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Ваша апелляция: «{wf.appealText}» — ожидает решения Маргариты.
        </p>
      )}

      {wf.decided && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          Решение Маргариты:{' '}
          <span className={`badge ${wf.badge}`}>
            {wf.approved ? 'Апелляция одобрена' : 'Апелляция отклонена'}
          </span>
          {wf.decisionComment ? ` — «${wf.decisionComment}»` : ''}
          {wf.approved ? ' Нарушение снято, штраф аннулирован.' : ''}
        </p>
      )}

      <ErrorMessage error={error} />

      {wf.canAcknowledge && (
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="btn btn-green" disabled={busy} onClick={handleAcknowledge}>
            ✓ Ознакомлен (согласен)
          </button>
        </div>
      )}

      {wf.canAppeal ? (
        <div className="field" style={{ marginBottom: 0 }}>
          <label>
            Не согласны? Напишите комментарий — апелляция уйдёт Маргарите
            (проверяющей) на рассмотрение
          </label>
          <textarea
            rows={3}
            placeholder="Ваш комментарий / причина несогласия с нарушением"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn" disabled={!comment.trim() || busy} onClick={handleAppeal}>
              {busy ? 'Отправка…' : 'Подать апелляцию'}
            </button>
          </div>
        </div>
      ) : (
        !wf.pendingAppeal &&
        !wf.decided && (
          <p className="hint" style={{ margin: 0 }}>
            Действий больше не требуется.
          </p>
        )
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
        {problem.penalty_amount ? (
          <span>
            Штраф:{' '}
            <b
              style={
                problem.penalty_cancelled
                  ? { textDecoration: 'line-through', color: 'var(--muted)' }
                  : {}
              }
            >
              {new Intl.NumberFormat('ru-RU').format(problem.penalty_amount)}
            </b>
            {problem.penalty_cancelled && ' (снят)'}
          </span>
        ) : null}
      </div>

      {context && <div className="description">{context}</div>}

      {isMargaritaProblem(problem) ? (
        <MargaritaReactionBox problem={problem} onDone={onSaved} />
      ) : (
        <ReactionBox problem={problem} onDone={onSaved} />
      )}

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
        <button className="btn btn-secondary" disabled={!canSave} onClick={handleSave}>
          {saving ? 'Отправка…' : 'Отправить ответ проверяющему'}
        </button>
        {showRequiredHint && (
          <span className="hint">Оба поля обязательны для сохранения.</span>
        )}
      </div>
    </div>
  )
}
