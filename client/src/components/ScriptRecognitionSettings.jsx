import {useEffect, useRef, useState} from 'react'

export default function ScriptRecognitionSettings({sessionId, socketRef, vocabulary = [], diagnostics = false, semantic = false}) {
  const [draft, setDraft] = useState(null)
  const [enabled, setEnabled] = useState(null)
  const [semanticEnabled, setSemanticEnabled] = useState(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState([])
  const revision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const save = () => {
    if (!socketRef.current?.connected) { setMessage('尚未連線，請稍後再儲存。'); return }
    const sentRevision = revision.current
    setSaving(true)
    socketRef.current.timeout(6000).emit('transcription:set-script-settings', {
      sessionId, scriptVocabulary: draft ?? vocabulary, acousticDiagnostics: enabled ?? diagnostics, semanticFollow: semanticEnabled ?? semantic,
    }, (error, response) => {
      if (!mounted.current) return
      setSaving(false)
      if (error || !response?.ok) { setMessage('未確認儲存成功，請重試。'); return }
      setPreview(response.keyterms || [])
      if (revision.current === sentRevision) {
        setDraft(null); setEnabled(null); setSemanticEnabled(null)
        setMessage(response.semanticFollow && !response.semanticReady
          ? '已儲存。語意恢復需在設定填入 OpenAI 金鑰，並重新開始收音才會就緒。'
          : '已儲存此節目的設定；收音中的詞彙提示會隨後更新。')
      } else setMessage('先前修改已儲存，畫面上的新修改尚未儲存。')
    })
  }
  return <div className="input-group">
    <label htmlFor="script-vocabulary">此節目的辨識詞彙表</label>
    <textarea id="script-vocabulary" rows={4} value={draft ?? vocabulary.join('\n')}
      placeholder="角色名稱、特殊用語、完整詞組；每行一個。換節目會使用各自的詞彙表。"
      onChange={event => { revision.current++; setDraft(event.target.value) }}/>
    <small>每詞 2～24 字，最多保存 200 詞。實際提示有總量限制，會優先選用自訂詞與附近劇本重要詞。</small>
    <label className="checkbox-row"><input type="checkbox" checked={enabled ?? diagnostics}
      onChange={event => { revision.current++; setEnabled(event.target.checked) }}/>
      啟用錄音頻譜診斷（預設關閉，不參與換格）
    </label>
    <label className="checkbox-row"><input type="checkbox" checked={semanticEnabled ?? semantic}
      onChange={event => { revision.current++; setSemanticEnabled(event.target.checked) }}/>
      啟用 AI 語意恢復（實驗功能，需 OpenAI 金鑰，依用量計費）
    </label>
    <small>僅在文字定位失敗時，送辨識文字與附近劇本。需兩段連續語意證據才恢復位置，不推測句尾；一般換格不等待 AI。</small>
    <button type="button" disabled={saving} onClick={save}>{saving ? '儲存中…' : '儲存詞彙與診斷設定'}</button>
    {message && <p role="status">{message}</p>}
    {preview.length > 0 && <details><summary>本次附近台詞的提示詞預覽</summary><p>{preview.join('、')}</p></details>}
  </div>
}
