// Auto-generated task-status message (req 3). Given a list of tasks, produce a
// copy-pasteable summary where each task line is prefixed with a status
// indicator:
//   🟢 done            — completed
//   ⭕ in process      — half done / being worked on
//   🔴 not done        — not started / postponed
// Kept DB-free and pure so it can be unit-tested and reused by any page.

import { TASK_STATUS } from './constants'

// Status → indicator emoji. A completed task is 🟢; an in-progress one is the
// red *empty* circle ⭕ («half done»); everything still outstanding (new /
// postponed) is the red *filled* circle 🔴 («not done»).
export const TASK_STATUS_EMOJI = {
  [TASK_STATUS.done]: '🟢',
  [TASK_STATUS.in_progress]: '⭕',
  [TASK_STATUS.open]: '🔴',
  [TASK_STATUS.postponed]: '🔴',
}

// The three explicit states a user picks with the status buttons (req 2), in the
// order they are shown. Each drives setTaskStatus with the mapped status.
export const TASK_PROGRESS = [
  { status: TASK_STATUS.done, emoji: '🟢', label: 'Выполнено' },
  { status: TASK_STATUS.in_progress, emoji: '⭕', label: 'В процессе' },
  { status: TASK_STATUS.open, emoji: '🔴', label: 'Не выполнено' },
]

// Normalise a task's status the way the UI does — the legacy `done` boolean is
// kept in sync with `status`, but older rows may only have `done`.
export function taskStatusOf(task) {
  if (!task) return TASK_STATUS.open
  return task.status || (task.done ? TASK_STATUS.done : TASK_STATUS.open)
}

export function taskEmoji(task) {
  return TASK_STATUS_EMOJI[taskStatusOf(task)] || '🔴'
}

// The readable name for a task line: its title, falling back to the client name.
export function taskLabel(task) {
  const name = (task?.title || '').trim()
  if (name) return name
  return (task?.client_name || 'Задача').trim()
}

// Build the auto-generated «Задачи:» message. Cancelled tasks are omitted (they
// are no longer to-dos). Returns '' when there is nothing to report so callers
// can hide an empty panel.
export function buildTaskMessage(tasks, { header = 'Задачи:' } = {}) {
  const lines = (tasks || [])
    .filter((t) => taskStatusOf(t) !== TASK_STATUS.cancelled)
    .map((t) => `${taskEmoji(t)} ${taskLabel(t)}`)
  if (lines.length === 0) return ''
  return [header, ...lines].join('\n')
}
