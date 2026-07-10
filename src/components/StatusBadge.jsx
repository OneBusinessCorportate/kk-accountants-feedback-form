import { STATUS, STATUS_LABELS } from '../lib/constants'

const COLOR = {
  [STATUS.new]: 'badge-gray',
  [STATUS.waiting_for_accountant]: 'badge-amber',
  [STATUS.submitted_by_accountant]: 'badge-blue',
  [STATUS.in_review]: 'badge-blue',
  [STATUS.fixed]: 'badge-green',
  [STATUS.explained_accepted]: 'badge-green',
  [STATUS.returned_to_accountant]: 'badge-red',
  [STATUS.auto_resolved]: 'badge-green',
  [STATUS.acknowledged]: 'badge-green',
  [STATUS.appeal_pending]: 'badge-amber',
  [STATUS.appeal_approved]: 'badge-green',
  [STATUS.appeal_rejected]: 'badge-red',
}

export default function StatusBadge({ status }) {
  return (
    <span className={`badge ${COLOR[status] || 'badge-gray'}`}>
      {STATUS_LABELS[status] || status}
    </span>
  )
}
