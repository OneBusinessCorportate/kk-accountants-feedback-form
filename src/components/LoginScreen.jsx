import { useState } from 'react'
import { signInWithCode } from '../lib/auth'

// Login gate: each employee types their personal code and is then scoped to
// their own problems. onLoggedIn(access) hands the resolved identity to App.
// Adapted from the accountants dashboard's LoginScreen, restyled to this app's
// plain-CSS look (no Tailwind / icon deps).
export default function LoginScreen({ onLoggedIn }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function onSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const access = await signInWithCode(code)
      if (!access) {
        setErr('Неверный код. Проверьте и попробуйте ещё раз.')
        setBusy(false)
        return
      }
      onLoggedIn(access)
    } catch (e2) {
      setErr(e2?.message || 'Не удалось войти')
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-eyebrow">OneBusiness</div>
        <h1 className="auth-title">Обратная связь бухгалтеров</h1>
        <p className="auth-subtitle">Введите свой код доступа, чтобы продолжить.</p>

        <div className="field">
          <label>Код доступа</label>
          <input
            className="code-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXXXXXX"
          />
        </div>

        {err && <div className="alert">{err}</div>}

        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Вход…' : 'Войти'}
          </button>
        </div>
      </form>
    </div>
  )
}
