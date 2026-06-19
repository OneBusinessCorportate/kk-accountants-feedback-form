import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { supabaseConfigError } from './lib/supabaseClient'
import Dashboard from './pages/Dashboard.jsx'
import Accountant from './pages/Accountant.jsx'
import Review from './pages/Review.jsx'
import Admin from './pages/Admin.jsx'

const links = [
  { to: '/', label: 'Дашборд', end: true },
  { to: '/accountant', label: 'Бухгалтер' },
  { to: '/review', label: 'Проверка' },
  { to: '/admin', label: 'Админ' },
]

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">KK · Обратная связь бухгалтеров</div>
        <nav className="nav">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}>
              {l.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="container">
        {supabaseConfigError ? (
          <div className="alert">
            <b>Конфигурация не завершена.</b> {supabaseConfigError} Задайте переменные окружения
            <code> VITE_SUPABASE_URL</code> и <code> VITE_SUPABASE_ANON_KEY</code> и пересоберите
            приложение.
          </div>
        ) : (
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/accountant" element={<Accountant />} />
            <Route path="/review" element={<Review />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  )
}
