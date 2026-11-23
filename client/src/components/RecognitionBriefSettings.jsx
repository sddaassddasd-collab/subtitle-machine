import {useEffect, useState} from 'react'

async function requestBrief(url, options) {
  const response = await fetch(url, options)
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.error || '無法讀取辨識提示，請稍後再試。')
  return result
}

export default function RecognitionBriefSettings({sessionId, apiKey}) {
  const endpoint = '/api/session/' + encodeURIComponent(sessionId) + '/recognition-brief'
  const [brief, setBrief] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    requestBrief(endpoint, {signal: controller.signal})
      .then(result => setBrief({...result, terms: result.terms.join('\n')}))
      .catch(error => {
        if (!controller.signal.aborted) setMessage(error.message)
      })
    return () => controller.abort()
  }, [endpoint, loadAttempt])

  const change = (key, value) => {
    setBrief(previous => ({...previous, [key]: value}))
    setMessage('')
  }

  const submit = async extracting => {
    setBusy(extracting ? 'extract' : 'save')
    setMessage('')
    try {
      const response = await requestBrief(extracting ? endpoint + '/extract' : endpoint, {
        method: extracting ? 'POST' : 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(extracting
          ? {source: brief.source, apiKey}
          : {...brief, terms: brief.terms.split('\n').map(term => term.trim()).filter(Boolean)}),
      })
      setBrief({...brief, ...response, terms: response.terms.join('\n')})
      setMessage(extracting ? '請核對背景和詞彙，再儲存辨識提示。' : '已儲存此節目的辨識提示。')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <details className="translation-language-access">
      <summary>從節目介紹擷取辨識提示</summary>
      {!brief ? (
        <p role="status">
          {message || '正在讀取已儲存的辨識提示…'}
          {message && <button type="button" onClick={() => {setMessage(''); setLoadAttempt(attempt => attempt + 1)}}>重試</button>}
        </p>
      ) : (
        <fieldset className="translation-language-access input-group" disabled={Boolean(busy)}>
          <label htmlFor="recognition-brief-source">節目介紹或製作名單</label>
          <textarea id="recognition-brief-source" rows={7} maxLength={12000} value={brief.source}
            onChange={event => change('source', event.target.value)}/>
          <small>擷取由 OpenAI 處理，確認並儲存後才會套用。</small>
          <button type="button" disabled={!brief.source.trim()} onClick={() => submit(true)}>
            {busy === 'extract' ? '擷取中…' : '擷取辨識提示'}
          </button>
          <label htmlFor="recognition-brief-summary">校對用節目背景</label>
          <textarea id="recognition-brief-summary" rows={3} maxLength={400} value={brief.summary}
            onChange={event => change('summary', event.target.value)}/>
          <label htmlFor="recognition-brief-terms">辨識與校對共用詞彙</label>
          <textarea id="recognition-brief-terms" rows={6} value={brief.terms}
            onChange={event => change('terms', event.target.value)}/>
          <small>一行一詞，最多 24 詞，每詞 2～24 字。最重要的人名、劇名放在前面。</small>
          <button type="button" onClick={() => submit(false)}>{busy === 'save' ? '儲存中…' : '儲存辨識提示'}</button>
          {message && <p role="status">{message}</p>}
        </fieldset>
      )}
    </details>
  )
}
