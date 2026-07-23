// Shared, dependency-free schedule math for the mailing planner/bot.
// Asia/Yerevan is UTC+4 with NO DST. Schedule days/times are Yerevan wall-clock;
// we materialise them as absolute UTC instants so the cabinet (browser tz) and
// the bot (Render = UTC) agree and a send lands on the intended Yerevan time —
// not a day late. Used by src/lib/notifications.js AND scripts/mailing_bot.mjs
// so there is one source of truth (tested in src/lib/schedule.test.js).

const YEREVAN_OFFSET_MS = 4 * 3600 * 1000

// The Yerevan calendar parts (y, m 0-based, day) of an absolute instant.
export function yerevanParts(instant) {
  const d = new Date(instant.getTime() + YEREVAN_OFFSET_MS)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() }
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

// A Yerevan wall-clock (y, m, day, hour, minute) as an absolute UTC Date.
function yerevanWallClockToUTC(y, m, day, hour, minute) {
  return new Date(Date.UTC(y, m, day, hour, minute) - YEREVAN_OFFSET_MS)
}

// The Yerevan day-of-month@hour:minute occurrence on/after `from`, as a UTC
// Date. Clamps the day to the month length (day 31 → Feb 28). No month skipped.
export function occurrenceOnOrAfter(from, dayOfMonth, hour = 11, minute = 0) {
  const make = (y, m) =>
    yerevanWallClockToUTC(y, m, Math.min(dayOfMonth || 1, lastDayOfMonth(y, m)), hour, minute)
  const { y, m } = yerevanParts(from)
  let occ = make(y, m)
  if (occ < from) {
    let ny = y
    let nm = m + 1
    if (nm > 11) {
      nm = 0
      ny += 1
    }
    occ = make(ny, nm)
  }
  return occ
}

// Current reporting period 'YYYYMM' with Margarita's 28th cutoff (from the 28th
// the period rolls to next month), computed in Yerevan.
export function currentPeriod(now) {
  const d = now ? new Date(now) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  let { y, m, day } = yerevanParts(d)
  if (day >= 28) {
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
  }
  return `${y}${String(m + 1).padStart(2, '0')}`
}

// Expand enabled schedule rows into concrete dated occurrences in [today,
// today+horizonDays], guaranteeing at least one of every enabled category.
// A row: { category, subtype, day_of_month, send_hour, send_minute, enabled }.
export function expandSchedule(rows, { today, horizonDays = 30 } = {}) {
  const start = today ? new Date(today) : null
  if (!start || Number.isNaN(start.getTime())) return []
  const end = new Date(start.getTime() + horizonDays * 86400000)
  const out = []
  for (const row of rows || []) {
    if (row.enabled === false) continue
    const hour = row.send_hour ?? 11
    const minute = row.send_minute ?? 0
    let occ = occurrenceOnOrAfter(start, row.day_of_month, hour, minute)
    let within = false
    while (occ <= end) {
      out.push(occurrence(row, occ))
      within = true
      occ = occurrenceOnOrAfter(new Date(occ.getTime() + 1000), row.day_of_month, hour, minute)
    }
    if (!within) out.push(occurrence(row, occ)) // ≥1 of every enabled type
  }
  return out.sort((a, b) => a.scheduledAt - b.scheduledAt)
}

function occurrence(row, when) {
  return {
    category: row.category,
    subtype: row.subtype,
    day_of_month: row.day_of_month,
    scheduledAt: when,
    scheduledISO: when.toISOString(),
  }
}
