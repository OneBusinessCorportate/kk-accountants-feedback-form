// Pure, DB-free aggregation of an accountant's OWN Margarita violation tickets,
// computed straight from kk_violation_workflow rows (the read-only projection of
// mqa_violations + latest mqa_violation_appeals — the QA platform's source of
// truth, migrations 0027/0029). Kept side-effect-free so it reads as the spec
// and is unit-tested without a browser or database (see violationReport.test.js).
//
// The dashboard shows Margarita's numbers, not a second copy: every metric here
// is derived from the same rows Margarita's own platform / Telegram report read.

// A ticket is shown to the accountant only when Margarita has NOT un-confirmed
// it. Mirrors the SQL predicate `confirmed <> false`: keep TRUE and NULL (never
// set) and drop only an explicit FALSE. We never write the column — we just
// hide the row (req 1).
export function isConfirmedTicket(row) {
  return row?.confirmed !== false
}

/** Keep only the confirmed tickets from a set of workflow rows. */
export function confirmedTickets(rows = []) {
  return rows.filter(isConfirmedTicket)
}

/** The fine attached to a violation as a number (0 when none / unparsable). */
export function sanctionOf(row) {
  const n = Number(row?.sanction)
  return Number.isFinite(n) ? n : 0
}

// mqa_violations.status vocabulary: new | acknowledged | appealed |
// appeal_approved | appeal_rejected. A violation is "cancelled" once its appeal
// was approved (the issue is dismissed and the fine cancelled); everything else
// is an active violation.
export function isCancelledViolation(row) {
  return (row?.status || 'new') === 'appeal_approved'
}

/**
 * The accountant's own mini-report (req 4) — the same metrics Margarita tracks
 * per accountant, derived from her tables:
 *   received   — tickets received (confirmed only)
 *   acknowledged — «Ознакомлен» reactions (acknowledged_at set / status)
 *   appealsFiled — how many carry an appeal
 *   approved / rejected / pending — the latest appeal's outcome
 *   activeViolations / cancelledViolations — after an approved appeal
 *   finesActive / finesCancelled — sanction sums by the same split
 *
 * Only CONFIRMED tickets are counted, matching what the list shows.
 */
export function summarizeMyViolations(rows = []) {
  const tickets = confirmedTickets(rows)
  const report = {
    received: tickets.length,
    acknowledged: 0,
    appealsFiled: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
    activeViolations: 0,
    cancelledViolations: 0,
    finesActive: 0,
    finesCancelled: 0,
  }

  for (const t of tickets) {
    const status = t.status || 'new'

    // «Ознакомлен» — the accountant reacted and accepted. acknowledged_at is
    // Margarita's own record and survives a later appeal, so count it too.
    if (t.acknowledged_at || status === 'acknowledged') report.acknowledged += 1

    // An appeal exists once a row was inserted (appeal_id) or the ticket moved
    // into an appeal state. Bucket by the latest appeal's outcome.
    const hasAppeal =
      !!t.appeal_id ||
      status === 'appealed' ||
      status === 'appeal_approved' ||
      status === 'appeal_rejected'
    if (hasAppeal) {
      report.appealsFiled += 1
      if (t.appeal_status === 'approved' || status === 'appeal_approved') report.approved += 1
      else if (t.appeal_status === 'rejected' || status === 'appeal_rejected') report.rejected += 1
      else report.pending += 1
    }

    const cancelled = isCancelledViolation(t)
    if (cancelled) report.cancelledViolations += 1
    else report.activeViolations += 1

    const fine = sanctionOf(t)
    if (fine > 0) {
      if (cancelled) report.finesCancelled += fine
      else report.finesActive += fine
    }
  }

  return report
}
