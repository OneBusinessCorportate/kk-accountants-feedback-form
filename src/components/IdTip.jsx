// The technical problem_id (e.g. KK-2026-0003) is an internal field, not a
// client-facing id, so we tuck it behind a small hover tooltip instead of
// showing it inline everywhere.
export default function IdTip({ problemId }) {
  if (!problemId) return null
  return (
    <span className="id-tip" title={`Внутренний ID: ${problemId}`}>
      ID
    </span>
  )
}
