import { useEffect, useState } from 'react'
import { fetchAttachments } from '../lib/api'

const isImage = (a) => (a.mime_type || '').startsWith('image/')

// Read-only list of files attached to a problem (documents / screenshots of
// the work done). Renders nothing while empty so cards stay clean.
export function AttachmentList({ problemId, refreshKey = 0 }) {
  const [items, setItems] = useState([])

  useEffect(() => {
    let alive = true
    fetchAttachments(problemId)
      .then((rows) => { if (alive) setItems(rows || []) })
      .catch(() => {})
    return () => { alive = false }
  }, [problemId, refreshKey])

  if (!items.length) return null

  return (
    <div className="attachments">
      <div className="attachments-label">Вложения</div>
      <ul className="attachments-list">
        {items.map((a) => (
          <li key={a.id}>
            <a href={a.public_url} target="_blank" rel="noreferrer">
              {isImage(a) ? '🖼' : '📎'} {a.file_name}
            </a>
            {a.uploaded_by && <span className="attachments-by"> — {a.uploaded_by}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

// File picker used in the feedback form. Attaching files is optional.
export function AttachmentPicker({ files, onFiles, disabled }) {
  return (
    <div className="field">
      <label>Файлы (необязательно) — документы, скриншоты выполненной работы</label>
      <input
        type="file"
        multiple
        disabled={disabled}
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
        onChange={(e) => onFiles(Array.from(e.target.files || []))}
      />
      {files.length > 0 && (
        <div className="attachments-picked">
          {files.map((f, i) => (
            <span key={i} className="attachments-chip">
              {f.name}
              <button
                type="button"
                className="attachments-remove"
                title="Убрать"
                onClick={() => onFiles(files.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
