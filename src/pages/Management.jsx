import { useState } from 'react'
import Review from './Review.jsx'
import Appeals from './Appeals.jsx'
import Admin from './Admin.jsx'

// One management page that merges what used to be three separate routes —
// «Проверка» (Review), «Апелляции» (Appeals) and «Админ» (Admin) — into a single
// tabbed page (owner decision, 2026-07). Each tab still renders the original,
// self-contained page component, so their behaviour is unchanged; only the
// navigation is consolidated. Management-only — the route is gated in App.jsx.
const TABS = [
  { key: 'review', label: 'Проверка', Component: Review },
  { key: 'appeals', label: 'Апелляции', Component: Appeals },
  { key: 'admin', label: 'Админ', Component: Admin },
]

export default function Management({ initialTab = 'review' }) {
  const [tab, setTab] = useState(
    TABS.some((t) => t.key === initialTab) ? initialTab : 'review',
  )
  const active = TABS.find((t) => t.key === tab) || TABS[0]
  const Active = active.Component

  return (
    <div>
      <div className="period-pills" style={{ marginBottom: 20 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`btn btn-sm ${tab === t.key ? '' : 'btn-secondary'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  )
}
