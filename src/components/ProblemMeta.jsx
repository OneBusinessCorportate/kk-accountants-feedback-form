import { SOURCE_LABELS, PRIORITY_LABELS } from '../lib/constants'

// Compact metadata row reused by the accountant + review cards.
export default function ProblemMeta({ problem }) {
  return (
    <>
      <div className="meta">
        <span>
          ID: <b>{problem.problem_id}</b>
        </span>
        {problem.client_name && (
          <span>
            Клиент: <b>{problem.client_name}</b>
          </span>
        )}
        <span>
          Источник: <b>{SOURCE_LABELS[problem.source] || problem.source}</b>
        </span>
        <span>
          Приоритет: <b>{PRIORITY_LABELS[problem.priority] || problem.priority}</b>
        </span>
        {problem.accountant_name && (
          <span>
            Бухгалтер: <b>{problem.accountant_name}</b>
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
      {problem.problem_description && (
        <div className="description">{problem.problem_description}</div>
      )}
      {problem.ai_comment && (
        <div className="kv">
          <div className="k">Комментарий AI / проверки</div>
          <div className="v">{problem.ai_comment}</div>
        </div>
      )}
    </>
  )
}
