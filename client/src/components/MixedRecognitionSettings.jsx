import {useState} from 'react'

const languageNames = new Intl.DisplayNames('zh-TW', {type: 'language'})
const languageName = code => {
  if (code === 'zh') return '中文（華語）'
  if (code === 'zh-HK') return '廣東話（粵語）'
  return languageNames.of(code)
}

export default function MixedRecognitionSettings({sessionId, socketRef, settings, options, busy}) {
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const current = draft ?? settings
  const valid = !current.enabled || current.languages.length >= 2

  const update = changes => {
    setDraft({...current, ...changes})
    setMessage('')
  }

  const save = () => {
    if (!socketRef.current?.connected) {
      setMessage('尚未連線，請稍後再儲存。')
      return
    }
    setSaving(true)
    setMessage('')
    socketRef.current.timeout(5000).emit('transcription:set-mixed-recognition', {
      sessionId, enabled: current.enabled, languages: current.languages,
    }, (error, response) => {
      setSaving(false)
      if (error || !response?.ok) {
        setMessage(response?.reason || '未收到儲存確認，請重試。')
        return
      }
      setDraft(null)
      setMessage('已儲存多語辨識設定。')
    })
  }

  return <fieldset className="translation-language-access" disabled={busy || saving}>
    <legend>演出多語辨識</legend>
    <label className="checkbox-row">
      <input type="checkbox" checked={current.enabled} onChange={event => update({enabled: event.target.checked})}/>
      啟用多語辨識
    </label>
    {current.enabled && <>
      <p className="input-note">
        {current.languages.length ? current.languages.map(languageName).join('、') : '請至少選擇兩種語言。'}
      </p>
      <details>
        <summary>選擇辨識語言</summary>
        <div className="translation-language-access-grid" style={{maxHeight: '14rem', overflowY: 'auto'}}>
          {options.map(code => <label key={code} className="translation-language-access-option">
            <input type="checkbox" checked={current.languages.includes(code)} onChange={event =>
              update({languages: event.target.checked
                ? [...current.languages, code]
                : current.languages.filter(language => language !== code)})}/>
            <span>{languageName(code)}</span>
          </label>)}
        </div>
      </details>
    </>}
    <p className="input-note">
      {busy ? '停止收音後即可更改。' : '使用 Deepgram Nova-3。勾選預期會說的語言，儲存後再開始收音。跟戲依照下方選定的劇本欄。'}
    </p>
    <button type="button" disabled={!draft || !valid} onClick={save}>{saving ? '儲存中…' : '儲存多語設定'}</button>
    {message && <p role="status">{message}</p>}
  </fieldset>
}
