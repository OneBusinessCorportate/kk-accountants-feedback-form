import { SOURCE_LABELS } from '../lib/constants'
import { formatAge, formatDate, problemContext } from '../lib/presentation'
import PriorityBadge from './PriorityBadge'

// Compact metadata row for the review (manager) card. Unlike the accountant
// view, the manager DOES see the source (who flagged the problem).
export default function ProblemMeta({ problem, showSource = true }) {
  const context = problemContext(problem)
  const detected = formatDate(problem.detected_at)
  const age = formatAge(problem.detected_at)

  return (
    <>
      <div className="meta">
        {problem.client_name && (
          <span>
            Клиент: <b>{problem.client_name}</b>
            {problem.contract_id && (
              <span className="contract-id"> {problem.contract_id}</span>
            )}
          </span>
        )}
        <span>
          Приоритет: <PriorityBadge priority={problem.priority} />
        </span>
        {showSource && (
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
            {age && <span className="age"> · {age}</span>}
          </span>
        )}
        {problem.chat_link && (
          <span>
            <a href={problem.chat_link} target="_blank" rel="noreferrer">
              Открыть чат{problem.chat_name ? ` (${problem.chat_name})` : ''} ↗
            </a>
          </span>
        )}
      </div>
      {context && <div className="description">{context}</div>}
    </>
  )
}
