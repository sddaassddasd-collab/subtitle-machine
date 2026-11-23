import './RecognitionPreview.css'

export default function RecognitionPreview({status, preview}) {
  const text = status === 'running' ? preview?.text : ''
  const waiting = {
    connecting: '正在連線到辨識服務…',
    running: '收音中，等待辨識文字…',
    error: '語音辨識已中斷',
  }

  return (
    <section className="recognition-preview" aria-labelledby="recognition-preview-title">
      <div className="recognition-preview-heading">
        <h3 id="recognition-preview-title">即時辨識文字</h3>
        {text && (
          <small className={preview.isFinal ? '' : 'recognition-preview-interim'}>
            {preview.isFinal ? '辨識完成' : '辨識中'}
          </small>
        )}
      </div>
      <p className={text ? '' : 'recognition-preview-empty'}>{text || waiting[status] || '尚未開始收音'}</p>
    </section>
  )
}
