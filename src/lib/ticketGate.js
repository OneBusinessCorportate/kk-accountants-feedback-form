// Mandatory "answer yesterday's tickets first" gate (pure logic).
//
// Owner rule: a regular accountant must NOT see any normal page (Дашборд,
// Задачи, Клиенты, Отчётность, …) until EVERY ticket assigned to them from
// YESTERDAY (the full previous calendar day, Asia/Yerevan) has been answered —
// each either accepted («Ознакомлен») or appealed («Подать апелляцию»).
//
// A "ticket" is exactly what the dashboard treats as real, active work, so the
// gate can NEVER block on something the platform itself considers irrelevant:
//   * Margarita/Sona reviews only (no AI), reviewer-confirmed false positives
//     dropped — this is `prepareDashboard().active`;
//   * on an ACTIVE chat (inactive/unknown/excluded/test chats are not `active`);
//   * with a resolved responsible accountant, scoped to THIS accountant.
// On top of that the gate keeps only yesterday's tickets and removes the ones
// already answered (an acknowledgement OR an appeal exists for that problem).
//
// Pure + DB-free so it is unit-tested and reused by the page and (future)
// anywhere else. Supervisors/management bypass the gate entirely (see isBlocked).

import { prepareDashboard, inYesterday, hasResponsibleAccountant } from './dashboard'
import { keepOwnProblems, seesAllClients } from './scope'

// The accountant's RELEVANT tickets detected yesterday.
//
// Owner decision (stricter): block on ACTIVE chats AND on "unknown" chats (a
// chat not found in kk_chat_directory) — as long as the ticket has a resolved
// responsible accountant. We still NEVER block on:
//   * inactive / excluded / test chats  → prepareDashboard puts them in `hidden`;
//   * confirmed false positives / AI     → dropped by prepareDashboard;
//   * tickets with no responsible accountant (req: never guess an owner).
//
// prepareDashboard splits rows into active / needsReview / hidden. `active` =
// active chat + resolved accountant. `needsReview` holds unknown-chat rows and
// no-accountant rows; from it we additionally take ONLY the ones that DO have a
// resolved accountant (i.e. unknown-chat-with-owner) — never the ownerless ones.
export function selectYesterdayTickets({ problems = [], chats = [], access, now = new Date() }) {
  const yesterday = problems.filter((p) => inYesterday(p, now))
  const { active, needsReview } = prepareDashboard({ problems: yesterday, chats, period: 'all', now })
  const unknownWithOwner = needsReview.filter((p) => hasResponsibleAccountant(p))
  // Scope to this accountant (uuid AND normalized name). Supervisors would see
  // all, but they bypass the gate anyway (isBlocked returns false for them).
  return keepOwnProblems([...active, ...unknownWithOwner], access)
}

// problem_ids that already have an acknowledgement or an appeal → "answered".
export function answeredProblemIds(acks = [], appeals = []) {
  const ids = new Set()
  for (const a of acks) if (a?.problem_id) ids.add(a.problem_id)
  for (const a of appeals) if (a?.problem_id) ids.add(a.problem_id)
  return ids
}

// Split yesterday's tickets into answered / unanswered and produce progress.
export function computeGate({ problems = [], chats = [], acks = [], appeals = [], access, now = new Date() }) {
  const tickets = selectYesterdayTickets({ problems, chats, access, now })
  const answered = answeredProblemIds(acks, appeals)
  const unanswered = tickets.filter((t) => !answered.has(t.problem_id))
  const answeredCount = tickets.length - unanswered.length
  return {
    tickets,
    unanswered,
    total: tickets.length,
    answered: answeredCount,
    remaining: unanswered.length,
    complete: unanswered.length === 0,
  }
}

// Would this user be BLOCKED right now? Supervisors/management never are. A
// regular accountant is blocked while any yesterday ticket is unanswered.
export function isBlocked(gate, access) {
  if (seesAllClients(access)) return false // explicit supervisor/management bypass
  return !gate.complete
}
