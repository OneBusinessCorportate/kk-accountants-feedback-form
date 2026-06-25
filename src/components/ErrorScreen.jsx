// Full-screen error state used by the auth gate when resolving the stored code
// fails (e.g. network / Supabase error). Offers a retry. Adapted from the
// dashboard's ErrorScreen to this app's plain CSS.
export default function ErrorScreen({ message, onRetry }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h2 className="auth-title">Ошибка</h2>
        <div className="alert" style={{ marginTop: 12 }}>
          {message || 'Не удалось загрузить данные.'}
        </div>
        {onRetry && (
          <div className="btn-row">
            <button className="btn" onClick={onRetry} style={{ width: '100%' }}>
              Попробовать снова
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
