import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { supabaseConfigError } from './lib/supabaseClient'
import { getStoredCode, resolveCode, signOut as authSignOut } from './lib/auth'
import { seesAllClients, canManage } from './lib/scope'
import { visibleNavLinks } from './lib/nav'
import { roleLabel } from './lib/constants'
import { AuthContext } from './lib/AuthContext'
import LoginScreen from './components/LoginScreen.jsx'
import LoadingScreen from './components/LoadingScreen.jsx'
import ErrorScreen from './components/ErrorScreen.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Accountant from './pages/Accountant.jsx'
import Review from './pages/Review.jsx'
import Appeals from './pages/Appeals.jsx'
import Reports from './pages/Reports.jsx'
import Admin from './pages/Admin.jsx'
import Tasks from './pages/Tasks.jsx'
import Clients from './pages/Clients.jsx'
import QAStats from './pages/QAStats.jsx'
import Accounting from './pages/Accounting.jsx'

export default function App() {
  // Auth gate state machine: loading → (anon | authed | error).
  const [status, setStatus] = useState('loading')
  const [access, setAccess] = useState(null)
  const [authError, setAuthError] = useState(null)

  // Resolve the stored code (if any) on startup / retry.
  const restore = useCallback(() => {
    const code = getStoredCode()
    if (!code) {
      setStatus('anon')
      return
    }
    setStatus('loading')
    setAuthError(null)
    resolveCode(code)
      .then((a) => {
        if (a) {
          setAccess(a)
          setStatus('authed')
        } else {
          // Stale / revoked code — drop it and ask again.
          authSignOut()
          setStatus('anon')
        }
      })
      .catch((e) => {
        setAuthError(e?.message || 'Не удалось войти')
        setStatus('error')
      })
  }, [])

  useEffect(() => {
    if (supabaseConfigError) return
    restore()
  }, [restore])

  function handleLoggedIn(a) {
    setAccess(a)
    setStatus('authed')
  }

  function handleSignOut() {
    authSignOut()
    setAccess(null)
    setStatus('anon')
  }

  // A misconfigured deploy fails loudly rather than throwing on every query.
  if (supabaseConfigError) {
    return (
      <div className="app">
        <main className="container">
          <div className="alert">
            <b>Конфигурация не завершена.</b> {supabaseConfigError} Задайте переменные окружения
            <code> VITE_SUPABASE_URL</code> и <code> VITE_SUPABASE_ANON_KEY</code> и пересоберите
            приложение.
          </div>
        </main>
      </div>
    )
  }

  if (status === 'loading') return <LoadingScreen />
  if (status === 'error') return <ErrorScreen message={authError} onRetry={restore} />
  if (status === 'anon') return <LoginScreen onLoggedIn={handleLoggedIn} />

  // Authenticated — build the nav from the user's reach.
  const supervisor = seesAllClients(access)
  const manage = canManage(access)

  const links = visibleNavLinks(manage)
  const roleText = roleLabel(access?.role)

  return (
    <AuthContext.Provider
      value={{ access, isSupervisor: supervisor, canManage: manage, signOut: handleSignOut }}
    >
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
          <div className="topbar-user">
            <span className="user-name">{access?.full_name || 'Сотрудник'}</span>
            {roleText && <span className="badge badge-gray">{roleText}</span>}
            <button className="btn btn-secondary btn-sm" onClick={handleSignOut}>
              Выйти
            </button>
          </div>
        </header>

        <main className="container">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/accountant" element={<Accountant />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/accounting" element={<Accounting />} />
            <Route path="/review" element={manage ? <Review /> : <Navigate to="/" replace />} />
            <Route path="/appeals" element={manage ? <Appeals /> : <Navigate to="/" replace />} />
            <Route path="/reports" element={manage ? <Reports /> : <Navigate to="/" replace />} />
            <Route path="/qa-stats" element={manage ? <QAStats /> : <Navigate to="/" replace />} />
            <Route path="/admin" element={manage ? <Admin /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </AuthContext.Provider>
  )
}
