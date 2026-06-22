import { priorityBadgeClass, priorityLabel } from '../lib/presentation'

export default function PriorityBadge({ priority }) {
  const label = priorityLabel(priority)
  if (!label) return null
  return (
    <span className={`badge ${priorityBadgeClass(priority)}`} title="Приоритет">
      {label}
    </span>
  )
}
