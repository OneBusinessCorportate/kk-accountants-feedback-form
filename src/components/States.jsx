// Tiny presentational helpers for loading / error / empty states.

export function Loading({ text = 'Загрузка…' }) {
  return <div className="loading">{text}</div>
}

export function ErrorMessage({ error }) {
  if (!error) return null
  return (
    <div className="alert">
      <b>Ошибка.</b> {typeof error === 'string' ? error : error.message}
    </div>
  )
}

export function Empty({ text = 'Ничего не найдено.' }) {
  return <div className="empty">{text}</div>
}
