// Full-screen loading state used by the auth gate while a stored code is being
// resolved. Adapted from the dashboard's LoadingScreen to this app's plain CSS.
export default function LoadingScreen({ text = 'Загрузка…' }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card auth-card-center">
        <div className="spinner" />
        <h2 className="auth-title" style={{ marginTop: 16 }}>
          {text}
        </h2>
      </div>
    </div>
  )
}
