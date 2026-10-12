import {useEffect, useId, useRef} from 'react'

export default function WorkspaceDialog({open, title, onClose, children}) {
  const ref = useRef(null), titleId = useId()
  useEffect(() => {
    if (open && !ref.current.open) ref.current.showModal()
    if (!open && ref.current.open) ref.current.close()
  }, [open])
  return <dialog ref={ref} className="workspace-dialog" aria-labelledby={titleId} onClose={() => { if (!ref.current.open) onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const box = event.currentTarget.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose()
    }}>
    <header className="workspace-dialog-header"><h2 id={titleId}>{title}</h2>
      <button type="button" className="subtle-button" onClick={onClose}>關閉</button></header>
    <div className="workspace-dialog-body">{children}</div>
  </dialog>
}
