import { useId, useState } from 'react'
import './RecognitionPreview.css'

export default function RecognitionPreview({status, preview}) {
  const [expanded, setExpanded] = useState(false)
  const textId = useId()
  const titleId = useId()
  const text = status === 'running' ? preview?.text : ''
  const waiting = {
    connecting: '正在連線到辨識服務…',
    running: '收音中，等待辨識文字…',
    error: '語音辨識已中斷',
  }

  return (
    <section className={`recognition-preview${expanded ? ' expanded' : ''}`} aria-labelledby={titleId}>
      <div className="recognition-preview-heading">
        <h3 id={titleId}>即時辨識文字</h3>
        {text && (
          <small className={preview.isFinal ? '' : 'recognition-preview-interim'}>
            {preview.isFinal ? '辨識完成' : '辨識中'}
          </small>
        )}
      </div>
      <p id={textId} className={text ? '' : 'recognition-preview-empty'}>{text || waiting[status] || '尚未開始收音'}</p>
      <button type="button" className="subtle-button" aria-expanded={expanded} aria-controls={textId}
        aria-label={expanded ? '收合即時辨識文字' : '展開即時辨識文字'}
        onClick={() => setExpanded(value => !value)}>
        {expanded ? '收合' : '展開'}
      </button>
    </section>
  )
}
