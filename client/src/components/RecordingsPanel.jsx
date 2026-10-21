import {useCallback, useEffect, useMemo, useRef, useState} from 'react'

const labels = {analysing: '分析聲音', transcribing: '辨識並對齊', ready: '已完成', error: '處理失敗', interrupted: '處理中斷', missing: '需重新匯入音檔'}
const segmentLabels = {auto: '自動對齊', manual: '已校正', review: '待確認', unmatched: '未對齊', stale: '字幕已修改', direction: '舞台指示'}
const timeLabel = seconds => `${Math.floor((seconds || 0) / 60)}:${((seconds || 0) % 60).toFixed(2).padStart(5, '0')}`

async function decodeRecording(file) {
  const Context = window.AudioContext || window.webkitAudioContext
  if (!Context) throw new Error('此瀏覽器無法解碼錄音，請使用新版 Chrome 或 Edge')
  const context = new Context({sampleRate: 16000})
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer())
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('音檔沒有可讀取的錄音內容')
    const worker = new Worker(new URL('../lib/recording-decode-worker.js', import.meta.url), {type: 'module'})
    const channels = Array.from({length: audio.numberOfChannels}, (_, i) => audio.getChannelData(i).slice())
    const pcm = await new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => { worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.pcm) }
      worker.onerror = () => { worker.terminate(); reject(new Error('無法分析音訊，請重試')) }
      worker.postMessage({channels, sampleRate: audio.sampleRate, duration: audio.duration}, channels.map(channel => channel.buffer))
    })
    return new Blob([pcm], {type: 'application/octet-stream'})
  } catch (error) {
    if (error.name === 'EncodingError') throw new Error('無法解碼此錄音，請改用 WAV、MP3 或 M4A')
    throw error
  } finally { await context.close() }
}

const recordingMime = file => file.type || ({wav:'audio/wav', mp3:'audio/mpeg', m4a:'audio/mp4', flac:'audio/flac', ogg:'audio/ogg', webm:'audio/webm', aac:'audio/aac'}[file.name.split('.').at(-1)?.toLowerCase()] || 'application/octet-stream')

export default function RecordingsPanel({sessionId, cellId, lines, referenceAudio, microphoneActive,
  performanceLanguage, sourceLanguages, followingScript, languages, visible = true}) {
  const [recordings, setRecordings] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [lineId, setLineId] = useState(lines[0]?.id || '')
  const [canTranscribe, setCanTranscribe] = useState(false)
  const [peaks, setPeaks] = useState([])
  const [start, setStart] = useState(0), [end, setEnd] = useState(1)
  const [viewport, setViewport] = useState(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [playTime, setPlayTime] = useState(0)
  const [importLanguage, setImportLanguage] = useState('performance')
  const [recordingLanguage, setRecordingLanguage] = useState('')
  const audioRef = useRef(null), inputRef = useRef(null), dragRef = useRef(null), clipEndRef = useRef(null)
  const scopeRef = useRef(`${sessionId}:${cellId}`)
  scopeRef.current = `${sessionId}:${cellId}`
  const recording = recordings.find(r => r.id === selectedId)
  const segment = recording?.segments.find(s => s.lineId === lineId)
  const recordingLines = useMemo(() => lines.map(line => ({...line, text: line.type === 'direction' ? line.text
    : recording?.scriptLanguageId === 'primary' ? line.text : line.translations?.[recording?.scriptLanguageId] || ''})), [lines, recording?.scriptLanguageId])
  const currentLine = recordingLines.find(line => line.id === lineId)
  const scriptSignature = useMemo(() => recordingLines.map(line => `${line.id}:${line.type}:${line.text}`).join('\n'), [recordingLines])
  const languageName = code => sourceLanguages.find(language => language.code === code)?.name || code
  const compatible = recording?.language === performanceLanguage && Boolean(followingScript?.languageId) &&
    recording?.scriptLanguageId === followingScript.languageId && recording?.compatible !== false
  const base = `/api/session/${encodeURIComponent(sessionId)}/recordings`
  const load = useCallback(async () => {
    const scope = scopeRef.current
    const response = await fetch(base)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '無法載入錄音')
    if (scope !== scopeRef.current) return
    setRecordings(data.recordings || []); setActiveId(data.activeRecordingId)
    setCanTranscribe(data.canTranscribe)
    const candidates = data.recordings.filter(r => r.cellId === cellId)
    setSelectedId(previous => candidates.some(r => r.id === previous)
      ? previous : candidates.find(r => r.id === data.activeRecordingId)?.id || candidates[0]?.id || '')
  }, [base, cellId])

  useEffect(() => {
    if (!visible) { audioRef.current?.pause(); clipEndRef.current = null; return }
    let disposed = false
    const refresh = () => load().catch(error => { if (!disposed) setError(error.message) })
    void refresh()
    const interval = window.setInterval(refresh, 2000)
    return () => { disposed = true; window.clearInterval(interval) }
  }, [load, cellId, scriptSignature, performanceLanguage, followingScript?.languageId, visible])
  useEffect(() => { setRecordingLanguage(recording?.language || '') }, [selectedId, recording?.language])
  useEffect(() => {
    if (!lines.some(line => line.id === lineId)) setLineId(lines[0]?.id || '')
  }, [lines, lineId])
  const savedStart = segment?.start ?? 0
  const savedEnd = segment?.end ?? Math.min(1, recording?.duration || 1)
  useEffect(() => {
    setStart(savedStart); setEnd(savedEnd); setViewport(null)
  }, [selectedId, lineId, recording?.revision, savedStart, savedEnd])
  useEffect(() => {
    let disposed = false
    const audio = audioRef.current
    setPeaks([]); setPlayTime(0); clipEndRef.current = null
    if (selectedId) fetch(`${base}/${encodeURIComponent(selectedId)}/waveform`).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '無法載入波形')
      if (!disposed) setPeaks(data.peaks || [])
    }).catch(error => { if (!disposed) setError(error.message) })
    return () => { disposed = true; audio?.pause() }
  }, [base, selectedId, recording?.status])

  const mutation = async (path, options) => {
    const response = await fetch(base + path, options)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '錄音操作失敗')
    await load(); return data
  }
  const act = async (label, callback) => {
    if (busy) return
    setBusy(label); setError(''); setNotice('')
    try { await callback() } catch (error) { setError(error.message) } finally { setBusy('') }
  }
  const handleImport = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void act('正在解碼與上傳…', async () => {
      if (file.size > 128 * 1024 * 1024) throw new Error('音檔最多 128 MB，請壓縮音檔後再匯入')
      const pcm = await decodeRecording(file)
      const form = new FormData()
      form.append('audio', new Blob([file], {type: recordingMime(file)}), file.name)
      form.append('pcm', pcm, 'reference.pcm')
      form.append('cellId', cellId)
      form.append('name', file.name)
      form.append('language', importLanguage === 'performance' ? performanceLanguage : importLanguage)
      const data = await mutation('', {method: 'POST', body: form})
      setSelectedId(data.recording.id); setNotice('錄音已匯入，背景分析進度會自動更新')
    })
  }
  const handleSave = () => act('保存中…', async () => {
    await mutation(`/${selectedId}/segments/${encodeURIComponent(lineId)}`, {method: 'PUT',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({start: Number(start), end: Number(end)})})
    setNotice('片段範圍已保存，可用於音訊跟戲')
  })
  const playClip = async () => {
    const audio = audioRef.current
    const from = Number(start), to = Number(end)
    if (!audio || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < 0 || to > recording.duration) return
    audio.currentTime = from; clipEndRef.current = to
    try { await audio.play() } catch { setError('無法播放錄音，請重新點擊試聽') }
  }
  const viewStart = viewport?.start || 0, viewEnd = viewport?.end || recording?.duration || 1
  const xAt = seconds => Math.max(0, Math.min(1000, (seconds - viewStart) / (viewEnd - viewStart) * 1000))
  const wavePoints = useMemo(() => {
    if (!peaks.length || !recording?.duration) return ''
    const points = []
    for (let i = 0; i < peaks.length; i++) {
      const seconds = i / peaks.length * recording.duration
      if (seconds < viewStart || seconds > viewEnd) continue
      const x = (seconds - viewStart) / (viewEnd - viewStart) * 1000
      points.push(`${x.toFixed(1)},${(50 - peaks[i] * 44).toFixed(1)}`)
    }
    return points.join(' ')
  }, [peaks, recording?.duration, viewStart, viewEnd])
  const moveHandle = (type, seconds) => {
    if (type === 'start') setStart(Math.max(0, Math.min(Number(end) - 0.12, seconds)))
    else setEnd(Math.min(recording.duration, Math.max(Number(start) + 0.12, seconds)))
  }
  const processing = ['analysing','transcribing'].includes(recording?.status)
  const scopeRecordings = recordings.filter(r => r.cellId === cellId)
  const lineIndex = lines.findIndex(line => line.id === lineId)

  return <div className="recordings-panel">
    <p>匯入彩排錄音後自動按字幕格切段。試聽校正後，按「使用此錄音跟戲」啟用音訊與文字並行判斷；文字先確認也會立即換格。</p>
    <label className="recording-select">匯入錄音的語言
      <select value={importLanguage} disabled={Boolean(busy)} onChange={event => setImportLanguage(event.target.value)}>
        <option value="performance">依演出語言（{languageName(performanceLanguage)}）</option>
        {sourceLanguages.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
      </select>
    </label>
    <div className="recording-actions">
      <button type="button" onClick={() => inputRef.current?.click()} disabled={Boolean(busy) || recordings.length >= 5}>
        {busy === '正在解碼與上傳…' ? busy : '匯入錄音並自動切段'}
      </button>
      <input ref={inputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.flac" hidden onChange={handleImport}/>
      <small>錄音時長不限；每份最多 128 MB，每個節目最多 5 份。</small>
    </div>
    {!canTranscribe && <p className="recording-note">尚未設定 Deepgram 金鑰，匯入後可先手動標記片段。</p>}
    {scopeRecordings.length > 0 && <>
      <label className="recording-select">目前場次的錄音
        <select value={scopeRecordings.some(r => r.id === selectedId) ? selectedId : ''} onChange={event => setSelectedId(event.target.value)}>
          <option value="" disabled>選擇錄音</option>
          {scopeRecordings.map(r => <option key={r.id} value={r.id}>{r.name} · {languageName(r.language)} · {labels[r.status] || r.status}</option>)}
        </select>
      </label>
      {recording && recording.cellId === cellId && <>
        <div className="recording-meta">
          <strong>{labels[recording.status] || recording.status}{processing ? ` ${recording.progress || 0}%` : ''}</strong>
          <span>{timeLabel(recording.duration)} · {recording.mappedCount} 格可用 · {recording.reviewCount} 格待確認</span>
          <span>{languageName(recording.language)} · 劇本欄：{languages.find(language => language.id === recording.scriptLanguageId)?.name || '尚未對應'}</span>
          {processing && <progress max="100" value={recording.progress || 0} aria-label="錄音處理進度"/>}
        </div>
        {recording.error && <p className="recording-note">{recording.error}</p>}
        {recording.followingScript?.message && <p className="recording-note">{recording.followingScript.message}</p>}
        <label className="recording-select">錄音辨識語言
          <select value={recordingLanguage} disabled={Boolean(busy) || processing} onChange={event => setRecordingLanguage(event.target.value)}>
            {sourceLanguages.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}
          </select>
        </label>
        <button type="button" className="subtle-button" disabled={Boolean(busy) || processing || recordingLanguage === recording.language}
          onClick={() => {
            if (recording.segments.some(segment => segment.status === 'manual') && !window.confirm('變更錄音語言會重新辨識並更新已校正的片段範圍，確定繼續？')) return
            void act('更新錄音語言…', () => mutation(`/${selectedId}/language`, {method: 'PUT',
              headers: {'Content-Type': 'application/json'}, body: JSON.stringify({language: recordingLanguage})}))
          }}>套用語言並重新辨識</button>
        <div className="recording-actions">
          <button type="button" className="subtle-button" disabled={Boolean(busy) || recording.status !== 'ready' ||
            (activeId !== selectedId && (!recording.mappedCount || !compatible))}
            onClick={() => act('切換中…', () => mutation('/active', {method: 'PUT', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({recordingId: activeId === selectedId ? null : selectedId})}))}>
            {activeId === selectedId ? '停用音訊跟戲' : '使用此錄音跟戲'}
          </button>
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing}
            onClick={() => {
              if (recording.segments.some(s => s.status === 'manual') && !window.confirm('重新自動切段會更新已校正的片段範圍，確定繼續？')) return
              void act('重新切段…', () => mutation(`/${selectedId}/align`, {method: 'POST'}))
            }}>{canTranscribe ? '重新自動切段' : '重新分析錄音'}</button>
          <button type="button" className="subtle-button danger-button" disabled={Boolean(busy)}
            onClick={() => {
              if (!window.confirm(`確定移除錄音「${recording.name}」與對齊標記？字幕劇本會保留。`)) return
              void act('移除中…', () => mutation(`/${selectedId}`, {method: 'DELETE'}))
            }}>移除錄音</button>
        </div>
        <p className="recording-note">{activeId === selectedId ? '此錄音已啟用；未確認的片段仍由文字跟戲。' : '此錄音尚未啟用，現場仍由文字跟戲。'}</p>
        {!compatible && <p className="recording-note">此錄音的語言或劇本欄與目前演出設定不同，無法啟用；請選擇對應錄音，或確認劇本欄後重新自動切段。</p>}
        {referenceAudio?.recordingId === selectedId && <p className="recording-live-status">
          音訊比對：{{loading:'載入中', listening:'等待人聲', searching:'尚未可靠定位', candidate:'核對中', verified:'已確認', error:'沿用文字跟戲'}[referenceAudio.status] || '等待收音'}
          {Number.isFinite(referenceAudio.referenceSeconds) && ` · 錄音 ${timeLabel(referenceAudio.referenceSeconds)}`}
          {Number.isFinite(referenceAudio.confidence) && ` · 聲音相似度 ${Math.round(referenceAudio.confidence * 100)}%`}
          {referenceAudio.error && ` · ${referenceAudio.error}`}
        </p>}
        <audio ref={audioRef} controls preload="metadata" src={`${base}/${selectedId}/audio`}
          onTimeUpdate={event => {
            setPlayTime(event.currentTarget.currentTime)
            if (clipEndRef.current !== null && event.currentTarget.currentTime >= clipEndRef.current) {
              event.currentTarget.pause(); clipEndRef.current = null
            }
          }}/>
        {microphoneActive && <small>收音中試聽請使用耳機，避免錄音進入現場麥克風。</small>}
        <label className="recording-select">對應字幕格
          <select value={lineId} onChange={event => setLineId(event.target.value)}>
            {recordingLines.map((line, index) => <option key={line.id} value={line.id}>{index + 1}. {line.text?.slice(0, 48) || '此語言缺少台詞'}</option>)}
          </select>
        </label>
        {currentLine && <div className="recording-segment-editor">
          <div className="recording-actions">
            <button type="button" className="subtle-button" disabled={lineIndex <= 0} onClick={() => setLineId(lines[lineIndex - 1].id)}>上一格</button>
            <button type="button" className="subtle-button" disabled={lineIndex >= lines.length - 1} onClick={() => setLineId(lines[lineIndex + 1].id)}>下一格</button>
            <span className={`recording-segment-state ${segment?.status || 'unmatched'}`}>{segmentLabels[segment?.status] || '未對齊'}</span>
          </div>
          <p className="recording-subtitle">{currentLine.text || '此語言缺少台詞，請先補齊對應劇本欄'}</p>
          {currentLine.type === 'direction' && <small>舞台指示保留在控制端；現場仍依句尾與靜默規則清屏。</small>}
          <svg viewBox="0 0 1000 100" className="recording-waveform" aria-label="錄音波形，可拖曳片段起點與終點"
            onPointerMove={event => {
              if (!dragRef.current || processing) return
              const box = event.currentTarget.getBoundingClientRect()
              moveHandle(dragRef.current, viewStart + Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * (viewEnd - viewStart))
            }} onPointerUp={() => {dragRef.current = null}} onPointerCancel={() => {dragRef.current = null}}>
            <rect width="1000" height="100" fill="#0f172a"/>
            <polyline points={wavePoints} fill="none" stroke="#64748b" strokeWidth="2"/>
            <polyline points={wavePoints} fill="none" stroke="#64748b" strokeWidth="2" transform="translate(0 100) scale(1 -1)"/>
            <rect x={xAt(start)} y="0" width={Math.max(0, xAt(end) - xAt(start))} height="100" fill="#2563eb" opacity="0.25"/>
            <line x1={xAt(playTime)} x2={xAt(playTime)} y1="0" y2="100" stroke="#fbbf24" strokeWidth="2"/>
            {['start','end'].map(type => <rect key={type} x={xAt(type === 'start' ? start : end) - 7} width="14" height="100"
              fill={type === 'start' ? '#22c55e' : '#f97316'} role="slider" tabIndex="0" aria-label={type === 'start' ? '片段起點' : '片段終點'}
              aria-valuemin="0" aria-valuemax={recording.duration} aria-valuenow={Number(type === 'start' ? start : end)}
              onPointerDown={event => {if (processing) return; dragRef.current = type; event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId)}}
              onKeyDown={event => {
                if (!['ArrowLeft','ArrowRight'].includes(event.key)) return
                if (processing) return
                event.preventDefault(); moveHandle(type, Number(type === 'start' ? start : end) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 0.5 : 0.05))
              }}/>) }
          </svg>
          <div className="recording-actions">
            <span>{timeLabel(viewStart)} — {timeLabel(viewEnd)}</span>
            <button type="button" className="subtle-button" onClick={() => setViewport(viewport ? null : {start: Math.max(0, Number(start) - 2), end: Math.min(recording.duration, Number(end) + 2)})}>
              {viewport ? '整段錄音' : '放大片段'}
            </button>
          </div>
          <div className="recording-boundaries">
            <label>起點（秒）<input type="number" disabled={processing} min="0" max={recording.duration} step="0.01" value={start} onChange={event => setStart(event.target.value)}/></label>
            <label>終點（秒）<input type="number" disabled={processing} min="0" max={recording.duration} step="0.01" value={end} onChange={event => setEnd(event.target.value)}/></label>
          </div>
          <div className="recording-actions">
            <button type="button" className="subtle-button" onClick={() => moveHandle('start', audioRef.current?.currentTime || 0)}>播放位置設為起點</button>
            <button type="button" className="subtle-button" onClick={() => moveHandle('end', audioRef.current?.currentTime || 0)}>播放位置設為終點</button>
            <button type="button" className="subtle-button" onClick={playClip} disabled={Number(end) <= Number(start)}>試聽片段</button>
            <button type="button" onClick={handleSave} disabled={Boolean(busy) || processing || Number(end) - Number(start) < 0.12 ||
              (currentLine.type !== 'direction' && !currentLine.text?.trim())}>確認並保存範圍</button>
          </div>
        </div>}
      </>}
    </>}
    {!scopeRecordings.length && <p className="recording-note">目前場次尚無參考錄音，沿用文字辨識跟戲。</p>}
    {error && <p className="recording-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>
}
