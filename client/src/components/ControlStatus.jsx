import { useEffect, useId, useRef } from 'react'

export function ControlStatusSummary({ automatic, status, audio, progress, confidence, hint, error }) {
  const fields = automatic
    ? [status, audio, progress || '進度待定位']
    : ['手動控制', '自動跟戲未啟用']

  return (
    <div className={`auto-follow-status${error ? ' auto-follow-status-error' : ''}`} title={[hint, confidence].filter(Boolean).join(' · ')}>
      <div className="auto-follow-status-fields">
        {fields.map((field, index) => <span key={index} title={field}>{field}</span>)}
      </div>
      {error && <div className="auto-follow-status-hint" role="alert">{hint}</div>}
    </div>
  )
}

export function ControlStatusDetails({ open, onClose, children }) {
  const dialogRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog ref={dialogRef} className="control-status-details" aria-labelledby={titleId} onClose={onClose}>
      <div className="control-status-details-header">
        <h3 id={titleId}>狀態詳情與收音診斷</h3>
        <button type="button" className="subtle-button" onClick={onClose} autoFocus>關閉</button>
      </div>
      {children}
    </dialog>
  )
}
