// Per-accountant data scoping for the feedback form.
//
// Ported from the accountants dashboard (ob-dashboards-for-accounters). The
// login identifies the employee; supervisors see every problem, while a regular
// accountant sees ONLY the problems assigned to them. Scoping is client-side by
// design: the problem list is filtered to the accountant's own rows BEFORE the
// page renders. The shared login_codes / resolve_login_code backend is untouched.
//
// NOTE on matching: resolve_login_code returns employee_id as a uuid, but
// kk_problems.accountant_id / accountant_name are free-text fields (legacy /
// ingested values, sometimes a slug like "acc-david", sometimes a display name).
// There is no FK between them, so we match defensively on BOTH the uuid and the
// (normalized) full name against either problem field. A problem only reaches a
// scoped accountant when one of these matches; supervisors bypass the filter.

// Roles that see ALL problems (management / oversight). Mirrors the dashboard's
// SUPERVISOR_ROLES so the same person has the same reach in both apps.
export const SUPERVISOR_ROLES = new Set([
  'head_accountant',
  'ceo',
  'founder',
  'qa',
  'admin',
])

// Normalize a name for comparison: trim, lowercase, collapse internal spaces.
function normName(v) {
  return (v ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Does this user see every problem (no scoping)?
 * @param access {employee_id, full_name, role, can_see_all} | null
 */
export function seesAllClients(access) {
  if (!access) return false
  if (access.can_see_all) return true
  return SUPERVISOR_ROLES.has(access.role)
}

/**
 * Can this user open the management areas (Review / Admin)? Same population as
 * supervisors — regular accountants only fill in their own feedback.
 */
export function canManage(access) {
  return seesAllClients(access)
}

/**
 * Is this problem assigned to the logged-in accountant? Matches the uuid
 * employee_id against accountant_id, and the normalized full_name against both
 * accountant_name and accountant_id (some rows store the name in the id field).
 */
export function ownsProblem(problem, access) {
  if (!access || !problem) return false

  const myId = access.employee_id != null ? String(access.employee_id) : null
  if (myId && problem.accountant_id != null && String(problem.accountant_id) === myId) {
    return true
  }

  const myName = normName(access.full_name)
  if (!myName) return false
  return normName(problem.accountant_name) === myName || normName(problem.accountant_id) === myName
}

/**
 * Filter a problem array down to what this user may see. Supervisors get every
 * row unchanged; everyone else gets only their own assigned problems.
 */
export function keepOwnProblems(problems, access) {
  if (seesAllClients(access)) return problems || []
  return (problems || []).filter((p) => ownsProblem(p, access))
}
