// Dashboard data layer — the single, tested place that turns raw kk_problems +
// kk-soprovozhdeniya (mqa_chats) into what the dashboard is allowed to show.
//
// Hard rules encoded here (owner decision, 2026-07):
//   1. NO AI analysis. Only Margarita (`margarita_review`) and Sona
//      (`sona_review`) review results are ever counted. Every other source —
//      notably the historical `ai` rows — is dropped before anything else runs.
//   2. Active chats only. kk-soprovozhdeniya (`mqa_chats.status = 'Active'`) is
//      the source of truth. Problems on an INACTIVE chat are hidden entirely;
//      problems whose chat can't be matched go to "Needs review", never counted.
//   3. Responsible accountant comes only from the resolved employee id. A row
//      with no resolved accountant goes to "Needs review" — we never guess.
//   4. Dedup so the same client/chat/day/problem never shows twice.
//   5. SLA / aging is measured in Margarita's working hours (10–13, 14–19,
//      Asia/Yerevan) — never with AI timing.
//
// These are PURE functions (no DB access) so they can be unit-tested and read as
// the spec. The pages fetch the rows and call prepareDashboard().

// ---- sources ---------------------------------------------------------------

// The only sources the dashboard may use. `ai` (and anything else) is excluded.
export const DASHBOARD_SOURCES = ['margarita_review', 'sona_review']

export function isDashboardSource(problem) {
  return DASHBOARD_SOURCES.includes(problem?.source)
}

// A reviewer-confirmed false positive is not real work.
export function isNotProblematic(problem) {
  return problem?.verdict === 'not_problematic'
}

// ---- client-name normalisation (req 8) -------------------------------------
// Trim, collapse internal whitespace and unify case so the SAME client is one
// entry. We normalise only for the comparison KEY; the displayed name keeps its
// original casing (just trimmed / de-spaced). Names that merely LOOK similar are
// NOT merged automatically — only an exact normalised match collapses.

export function cleanClientName(name) {
  if (name == null) return ''
  return name.toString().replace(/\s+/g, ' ').trim()
}

export function clientKey(name) {
  return cleanClientName(name).toLowerCase()
}

// ---- chat identity + active-chat index -------------------------------------
// A problem is tied to a chat by its Telegram link (preferred) or the contract
// number (agr_no). mqa_chats holds both plus the Active/Inactive status.

export function normalizeContract(value) {
  if (value == null) return ''
  return value
    .toString()
    .replace(/№\s*/g, '')
    .replace(/В/g, 'B') // Cyrillic В → Latin B
    .replace(/Н/g, 'N') // Cyrillic Н → Latin N
    .replace(/\s+/g, '')
    .trim()
    .toUpperCase()
}

export function normalizeChatLink(link) {
  if (link == null) return ''
  return link.toString().trim().toLowerCase().replace(/\/+$/, '')
}

// Build lookup sets of ACTIVE chats from the kk-soprovozhdeniya rows. A chat is
// active when mqa_chats.status trimmed/lowercased === 'active'. We also keep the
// set of ALL known chats so we can tell "inactive" from "unknown".
export function buildChatIndex(chats = []) {
  const activeLinks = new Set()
  const activeContracts = new Set()
  const knownLinks = new Set()
  const knownContracts = new Set()
  for (const c of chats) {
    const active = (c.status ?? '').toString().trim().toLowerCase() === 'active'
    const link = normalizeChatLink(c.chat_link)
    const agr = normalizeContract(c.agr_no)
    if (link) {
      knownLinks.add(link)
      if (active) activeLinks.add(link)
    }
    if (agr) {
      knownContracts.add(agr)
      if (active) activeContracts.add(agr)
    }
  }
  return { activeLinks, activeContracts, knownLinks, knownContracts }
}

// 'active' | 'inactive' | 'unknown' for a problem against the chat index.
// A null/empty index (e.g. kk-soprovozhdeniya failed to load) yields 'unknown'
// for everything so nothing is silently dropped.
export function chatActivity(problem, index) {
  if (!index) return 'unknown'
  const link = normalizeChatLink(problem?.chat_link)
  const agr = normalizeContract(problem?.contract_id)
  if (link && index.activeLinks.has(link)) return 'active'
  if (agr && index.activeContracts.has(agr)) return 'active'
  if (link && index.knownLinks.has(link)) return 'inactive'
  if (agr && index.knownContracts.has(agr)) return 'inactive'
  return 'unknown'
}

// ---- responsible accountant (req 7) ----------------------------------------
// Only a resolved employee id counts. No id → nobody is blamed → needs review.
export function hasResponsibleAccountant(problem) {
  return problem?.accountant_id != null && String(problem.accountant_id).trim() !== ''
}

// ---- categories (req 5/6) --------------------------------------------------
// Primary category is exclusive; `sla` is an overlapping tag (a violation about
// deadlines is both a violation and an SLA item).

export const CATEGORY = {
  violation: 'violation', // Margarita нарушения
  quality: 'quality', // Margarita оценки качества сервиса
  sona: 'sona', // Sona качество бухгалтерии
}

// Titles/word-stems that mean a timing / responsiveness (SLA) problem.
const SLA_STEMS = ['срок', 'обещан', 'обратн', 'своевремен', 'задерж', 'незакрыт', 'фиксац']

export function isSlaProblem(problem) {
  if (problem?.source !== 'margarita_review') return false
  const title = (problem.problem_title ?? '').toLowerCase()
  return SLA_STEMS.some((s) => title.includes(s))
}

export function categoryOf(problem) {
  if (problem?.source === 'sona_review') return CATEGORY.sona
  const title = (problem?.problem_title ?? '').toLowerCase()
  // Quality scorecards (margarita_eval) carry «...оценка качества сервиса».
  if (title.includes('оценка качества')) return CATEGORY.quality
  return CATEGORY.violation
}

// ---- dedup (req 4) ---------------------------------------------------------
// Two rows are the "same" problem when they share source + chat + accountant +
// day + title. We keep one and remember the distinct sources on it so a client
// that legitimately spans sources is shown once with every source listed.

function problemDay(problem) {
  const raw = problem?.detected_at || problem?.created_at
  if (!raw) return ''
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function dedupKey(problem) {
  const chat = normalizeChatLink(problem?.chat_link) || normalizeContract(problem?.contract_id)
  return [
    problem?.source ?? '',
    chat || clientKey(problem?.client_name),
    (problem?.accountant_id ?? '').toString().toLowerCase(),
    problemDay(problem),
    (problem?.problem_title ?? '').toLowerCase().trim(),
  ].join('|')
}

// Collapse exact duplicates. Keeps the first occurrence (callers sort first when
// order matters), attaches `.sources` = the set of sources seen for that key.
export function dedupeProblems(problems = []) {
  const byKey = new Map()
  for (const p of problems) {
    const key = dedupKey(p)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...p, sources: [p.source] })
    } else if (!existing.sources.includes(p.source)) {
      existing.sources.push(p.source)
    }
  }
  return [...byKey.values()]
}

// ---- date filtering (req 3) ------------------------------------------------
// Periods change the data: everything is filtered by detected_at (fallback
// created_at). Boundaries are day-aligned in Asia/Yerevan so "Сегодня" means the
// local calendar day, not a rolling 24h in the browser's timezone.

export const TZ_OFFSET_MIN = 240 // Asia/Yerevan, UTC+4 (no DST)

export const PERIODS = [
  { key: 'today', label: 'Сегодня' },
  { key: '2d', label: '2 дня' },
  { key: 'week', label: 'Неделя' },
  { key: 'all', label: 'Всё время' },
]

// Start of the local day, `daysBack` days ago, returned as a UTC Date.
function localDayStart(now, daysBack) {
  const shifted = now.getTime() + TZ_OFFSET_MIN * 60000
  const DAY = 86400000
  const localMidnight = Math.floor(shifted / DAY) * DAY - daysBack * DAY
  return new Date(localMidnight - TZ_OFFSET_MIN * 60000)
}

// The inclusive lower bound (Date) for a period, or null for "all".
export function periodStart(key, now = new Date()) {
  if (key === 'today') return localDayStart(now, 0)
  if (key === '2d') return localDayStart(now, 1) // today + yesterday
  if (key === 'week') return localDayStart(now, 6) // last 7 calendar days
  return null
}

export function problemDate(problem) {
  const raw = problem?.detected_at || problem?.created_at
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export function inPeriod(problem, key, now = new Date()) {
  const start = periodStart(key, now)
  if (!start) return true
  const d = problemDate(problem)
  if (!d) return false
  return d.getTime() >= start.getTime()
}

// The FULL previous calendar day in Asia/Yerevan (not a rolling 24h): an
// inclusive start (yesterday 00:00 local) and an exclusive end (today 00:00
// local), both as UTC Dates. Used by the mandatory yesterday-tickets gate.
export function yesterdayRange(now = new Date()) {
  return { start: localDayStart(now, 1), end: localDayStart(now, 0) }
}

// Is this problem's business date (detected_at, fallback created_at) within
// yesterday in Asia/Yerevan?
export function inYesterday(problem, now = new Date()) {
  const { start, end } = yesterdayRange(now)
  const d = problemDate(problem)
  if (!d) return false
  const t = d.getTime()
  return t >= start.getTime() && t < end.getTime()
}

// ---- date display (req 3: "даты отображаются неправильно") -----------------
// Format a timestamp in Asia/Yerevan so the shown date matches the business day.
export function formatDate(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Yerevan' })
}

// ---- SLA / aging in working hours (req 1/5) --------------------------------
// Working hours (Asia/Yerevan): 10:00–13:00 and 14:00–19:00. Lunch 13–14 and
// any time outside the windows does not count. A question that arrives after
// 19:00 effectively starts the next working morning; one arriving 13:00–14:00
// starts at 14:00 — both fall out naturally from summing window overlaps.

const WORK_WINDOWS = [
  [10 * 60, 13 * 60], // 10:00–13:00
  [14 * 60, 19 * 60], // 14:00–19:00
]

// Working MINUTES between two instants, honoring the windows above.
export function businessMinutesBetween(start, end) {
  const s = new Date(start).getTime() + TZ_OFFSET_MIN * 60000
  const e = new Date(end).getTime() + TZ_OFFSET_MIN * 60000
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0
  const DAY = 86400000
  let total = 0
  for (let day = Math.floor(s / DAY) * DAY; day < e; day += DAY) {
    for (const [w0, w1] of WORK_WINDOWS) {
      const lo = Math.max(s, day + w0 * 60000)
      const hi = Math.min(e, day + w1 * 60000)
      if (hi > lo) total += (hi - lo) / 60000
    }
  }
  return Math.round(total)
}

export function businessHoursBetween(start, end) {
  return businessMinutesBetween(start, end) / 60
}

// First-response SLA target per priority, in WORKING hours. The working day is
// 8 hours long (10:00–13:00 + 14:00–19:00), so high ≈ 1 day, medium ≈ 3 days,
// low ≈ 5 days.
export const SLA_BUSINESS_HOURS = { 1: 8, 2: 24, 3: 40 }

// A still-open problem is overdue once its working-hours age passes the target.
export function isOverdue(problem, now = new Date()) {
  const from = problem?.detected_at || problem?.created_at
  if (!from) return false
  const target = SLA_BUSINESS_HOURS[problem?.priority] ?? SLA_BUSINESS_HOURS[2]
  return businessHoursBetween(from, now) > target
}

// Human working-hours age, e.g. "3 раб. ч" / "2 раб. дн".
export function formatBusinessAge(value, now = new Date()) {
  if (!value) return ''
  const hours = businessHoursBetween(value, now)
  if (hours < 1) return 'меньше часа'
  if (hours < 8) return `${Math.round(hours)} раб. ч`
  const days = Math.round((hours / 8) * 10) / 10 // 8 working hours per day
  return `${days} раб. дн`
}

// ---- the one entry point ---------------------------------------------------
// Turn raw rows into everything the dashboard renders. Never mutates inputs.
//
//   problems   — raw kk_problems rows (any source)
//   chats      — kk-soprovozhdeniya rows (mqa_chats)
//   period     — one of PERIODS[].key
//   now        — injectable clock for tests
//
// Returns { active, needsReview, hidden, byCategory, counts }.
export function prepareDashboard({ problems = [], chats = [], period = 'all', now = new Date() } = {}) {
  const index = buildChatIndex(chats)

  // 1. sources: Margarita + Sona only, drop confirmed false positives.
  const allowed = problems.filter((p) => isDashboardSource(p) && !isNotProblematic(p))

  // 2. dedup.
  const deduped = dedupeProblems(allowed)

  // 3. date period.
  const inRange = deduped.filter((p) => inPeriod(p, period, now))

  // 4. split into active / needs-review / hidden by chat activity + accountant.
  const active = []
  const needsReview = []
  const hidden = []
  for (const p of inRange) {
    const activity = chatActivity(p, index)
    if (activity === 'inactive') {
      hidden.push(p)
      continue
    }
    if (activity === 'unknown' || !hasResponsibleAccountant(p)) {
      needsReview.push({
        ...p,
        review_reason:
          activity === 'unknown'
            ? 'Чат не найден в kk-soprovozhdeniya'
            : 'Не определён ответственный бухгалтер',
      })
      continue
    }
    active.push({ ...p, category: categoryOf(p), sla: isSlaProblem(p) })
  }

  const byCategory = {
    violation: active.filter((p) => p.category === CATEGORY.violation),
    quality: active.filter((p) => p.category === CATEGORY.quality),
    sona: active.filter((p) => p.category === CATEGORY.sona),
    sla: active.filter((p) => p.sla),
    overdue: active.filter((p) => isOverdue(p, now)),
  }

  return {
    active,
    needsReview,
    hidden,
    byCategory,
    counts: {
      total: active.length,
      violation: byCategory.violation.length,
      quality: byCategory.quality.length,
      sona: byCategory.sona.length,
      sla: byCategory.sla.length,
      overdue: byCategory.overdue.length,
      needsReview: needsReview.length,
    },
  }
}

// Group active problems by client for the Clients view — one row per client,
// merging chats/sources, so a client never repeats (req 4/8).
export function groupClients(problems = []) {
  const map = new Map()
  for (const p of problems) {
    const display = cleanClientName(p.client_name) || cleanClientName(p.chat_name) || '(без имени)'
    const key = display.toLowerCase()
    if (!map.has(key)) {
      map.set(key, {
        name: display,
        key,
        problems: [],
        sources: new Set(),
        accountants: new Set(),
        chats: new Map(),
        contracts: new Set(),
      })
    }
    const row = map.get(key)
    row.problems.push(p)
    row.sources.add(p.source)
    if (p.accountant_name) row.accountants.add(p.accountant_name)
    const c = normalizeContract(p.contract_id)
    if (c) row.contracts.add(c)
    const link = p.chat_link
    if (link && !row.chats.has(link)) {
      row.chats.set(link, { name: p.chat_name || p.client_name || 'Чат', link })
    }
  }
  return [...map.values()].map((r) => ({
    name: r.name,
    key: r.key,
    problems: r.problems,
    sources: [...r.sources],
    accountants: [...r.accountants],
    chats: [...r.chats.values()],
    contracts: [...r.contracts],
  }))
}

// ---- mailings / рассылки ---------------------------------------------------
// The real record of whether a client mailing was done lives in Margarita's
// mqa_chat_mailings (exposed via kk_chat_mailings), NOT in kk_tasks — which is
// why done mailings used to show as "not done". Margarita words completion
// differently per category, so normalise the status before checking:
//   done   — «Отправил» (sent), «Получил» (received), «Нет долга» (no debt),
//            or confirmed = true
//   pending— «Не отправил», «Запросил …, не получил», «Предстоящая»,
//            «… написал / позвонил» (debt reminder still in progress)
//   ignore — «Inactive» / blank
// Negatives are checked FIRST so «Не отправил» is not mistaken for «Отправил».

const MAILING_DONE_STEMS = ['отправил', 'получил', 'нет долга']
const MAILING_PENDING_STEMS = ['не отправил', 'не получил', 'предстоящ', 'написал', 'позвонил']

export function classifyMailingStatus(row = {}) {
  const s = (row.status ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
  if (s === '' || s === 'inactive') return 'ignore'
  if (row.confirmed === true) return 'done'
  if (MAILING_PENDING_STEMS.some((k) => s.includes(k))) return 'pending'
  if (MAILING_DONE_STEMS.some((k) => s.includes(k))) return 'done'
  // Unknown wording → treat as not-yet-done so we never invent a false "done".
  return 'pending'
}

// Build contract → 'done' | 'pending' from the mailing rows, using each
// contract's LATEST period only (older months don't mask the current state).
export function buildMailingIndex(mailings = []) {
  const byContract = new Map() // contract → Map(period → {done, pending})
  for (const m of mailings) {
    const c = normalizeContract(m.agr_no)
    if (!c) continue
    const cls = classifyMailingStatus(m)
    if (cls === 'ignore') continue
    if (!byContract.has(c)) byContract.set(c, new Map())
    const periods = byContract.get(c)
    const period = (m.period ?? '').toString()
    if (!periods.has(period)) periods.set(period, { done: 0, pending: 0 })
    periods.get(period)[cls] += 1
  }
  const out = new Map()
  for (const [c, periods] of byContract) {
    const latest = [...periods.keys()].sort().pop()
    const agg = periods.get(latest)
    out.set(c, agg.pending > 0 ? 'pending' : agg.done > 0 ? 'done' : 'none')
  }
  return out
}

// A client's overall mailing state across its contracts:
//   'done'    — has completed mailing(s) and nothing still pending
//   'pending' — something is still outstanding (or a mix of done + pending)
//   'none'    — no mailing records at all (fall back to manual kk_tasks)
export function mailingStateForContracts(contracts = [], index) {
  if (!index) return 'none'
  let anyKnown = false
  let anyDone = false
  let anyPending = false
  for (const raw of contracts) {
    const st = index.get(normalizeContract(raw))
    if (!st || st === 'none') continue
    anyKnown = true
    if (st === 'done') anyDone = true
    if (st === 'pending') anyPending = true
  }
  if (!anyKnown) return 'none'
  if (anyPending) return 'pending'
  return anyDone ? 'done' : 'none'
}
