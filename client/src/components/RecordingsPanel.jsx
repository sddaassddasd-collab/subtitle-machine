import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import RecordingTranscript from './RecordingTranscript'
import {pickRecording, recallRecording, forgetRecording} from '../lib/local-recordings'
import {prepareLocalRecording, linkLocalRecording, localKey, recordingJSON} from '../lib/local-recording-client'

const labels = {local: '待完成本機準備', analysing: '分析聲音', transcribing: '辨識並對齊', ready: '已完成', error: '處理失敗', interrupted: '處理中斷', missing: '需重新匯入音檔'}
const segmentLabels = {auto: '自動對齊', manual: '已校正', review: '待確認', unmatched: '未對齊', stale: '字幕已修改', direction: '舞台指示'}
const timeLabel = seconds => {
  const ticks = Math.max(0, Math.round((seconds || 0) * 100)), hours = Math.floor(ticks / 360000)
  const minutes = Math.floor(ticks / 6000) % 60, tail = ((ticks % 6000) / 100).toFixed(2).padStart(5, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`
}

export default function RecordingsPanel({sessionId, cellId, lines, referenceAudio, microphoneActive,
  performanceLanguage, sourceLanguages, followingScript, languages, apiKey, visible = true}) {
  const [recordings, setRecordings] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [lineId, setLineId] = useState(lines[0]?.id || '')
  const [canTranscribe, setCanTranscribe] = useState(false)
  const [canAlignWithAI, setCanAlignWithAI] = useState(false)
  const [playerDuration, setPlayerDuration] = useState(null)
  const [peaks, setPeaks] = useState([])
  const [waveInfo, setWaveInfo] = useState({from: 0, peakSeconds: 1})
  const [localFile, setLocalFile] = useState(null)
  const [audioSource, setAudioSource] = useState('')
  const [fileNotice, setFileNotice] = useState('')
  const jobRef = useRef(null), pickIntent = useRef('import'), backupRef = useRef(null)
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
    setCanTranscribe(data.canTranscribe); setCanAlignWithAI(data.canAlignWithAI)
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
  useEffect(() => () => jobRef.current?.abort(), [])
  useEffect(() => () => jobRef.current?.abort(), [sessionId, cellId])
  useEffect(() => {
    let disposed = false
    setFileNotice('')
    if (recording?.source === 'local') {
      recallRecording(localKey(sessionId, selectedId)).then(entry => {
        if (disposed) return
        if (entry?.file && entry.fingerprint === recording.fingerprint && entry.file.size === recording.byteLength &&
          (entry.lastModified === undefined || entry.lastModified === entry.file.lastModified)) {
          setLocalFile({id: selectedId, entry})
        } else setFileNotice('原音檔尚未連結。已完成的跟戲資料仍可使用；試聽或繼續辨識時再連結。')
      }).catch(() => { if (!disposed) setFileNotice('無法恢復本機檔案，請重新連結；已完成的跟戲資料仍可使用。') })
    }
    return () => { disposed = true }
  }, [sessionId, selectedId, recording?.source, recording?.fingerprint, recording?.byteLength])
  useEffect(() => {
    setPlayerDuration(null)
    if (recording?.source !== 'local') { setAudioSource(selectedId ? `${base}/${selectedId}/audio` : ''); return }
    if (localFile?.id !== selectedId) { setAudioSource(''); return }
    const url = URL.createObjectURL(localFile.entry.file)
    setAudioSource(url)
    return () => URL.revokeObjectURL(url)
  }, [base, selectedId, recording?.source, localFile])
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
    if (selectedId && (recording?.source !== 'local' || recording?.status === 'ready')) fetch(`${base}/${encodeURIComponent(selectedId)}/waveform${recording?.source === 'local' && viewport ? `?start=${viewport.start}&end=${viewport.end}` : ''}`).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '無法載入波形')
      if (!disposed) { setPeaks(data.peaks || []); setWaveInfo({from: data.from || 0, peakSeconds: data.peakSeconds || data.duration / Math.max(1, data.peaks?.length || 0)}) }
    }).catch(error => { if (!disposed) setError(error.message) })
    return () => { disposed = true; audio?.pause() }
  }, [base, selectedId, recording?.status, recording?.source, viewport])

  const mutation = async (path, options) => {
    const response = await fetch(base + path, options)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '錄音操作失敗')
    await load(); return data
  }
  const act = async (label, callback) => {
    if (busy) return
    setBusy(label); setError(''); setNotice('')
    try { await callback() } catch (error) { if (error.name === 'AbortError') setNotice('準備已停止，已保存的片段可稍後繼續。'); else setError(error.message) } finally { setBusy('') }
  }
  const processEntry = (entry, intent) => act('正在核對本機音檔…', async () => {
    const abort = new AbortController()
    jobRef.current = abort
    const scope = scopeRef.current
    try {
      if (intent === 'link') {
        const linked = await linkLocalRecording({entry, sessionId, recording, signal: abort.signal, onProgress: setBusy})
        if (scope === scopeRef.current) {
          setLocalFile({id: selectedId, entry: linked}); setFileNotice('')
          setNotice(linked.remembered ? '已連結原音檔，可直接試聽。' : '已連結原音檔；瀏覽器無法保存連結，重開時需再選取。')
        }
      } else {
        await prepareLocalRecording({entry, sessionId, cellId, language: importLanguage === 'performance' ? performanceLanguage : importLanguage,
          existing: intent === 'resume' ? recording : null, signal: abort.signal, onProgress: setBusy, onNotice: setNotice,
          onRecording: (value, linked) => {
            if (scope === scopeRef.current) {
              setRecordings(previous => [...previous.filter(item => item.id !== value.id), value])
              setSelectedId(value.id); setLocalFile({id: value.id, entry: linked}); setFileNotice('')
            }
          }})
        await load()
      }
    } finally { jobRef.current = null }
  })
  const chooseFile = async (intent = 'import') => {
    if (busy) return
    pickIntent.current = intent
    try {
      if (intent !== 'import') {
        const entry = await recallRecording(localKey(sessionId, selectedId), true).catch(() => null)
        if (entry) { await processEntry(entry, intent); return }
      }
      const entry = await pickRecording()
      if (entry) await processEntry(entry, intent)
      else inputRef.current?.click()
    } catch (error) { if (error.name !== 'AbortError') setError(error.message) }
  }
  const handleImport = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void processEntry({file}, pickIntent.current)
  }
  const importBackup = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void act('匯入錄音分析備份…', async () => {
      const data = await recordingJSON(`${base}/local/import?cellId=${encodeURIComponent(cellId)}`, {method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'}, body: file})
      await load(); setSelectedId(data.recording.id)
      setNotice('分析資料已還原；若台詞標記不符目前劇本，請重新自動切段。試聽時再連結原音檔。')
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
    if (!audio || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || from < 0 || to > (playerDuration || recording.playbackDuration || recording.duration)) return
    audio.currentTime = from; clipEndRef.current = to
    try { await audio.play() } catch { setError('無法播放錄音，請重新點擊試聽') }
  }
  const displayDuration = playerDuration || recording?.playbackDuration || recording?.duration || 1
  const viewStart = viewport?.start || 0, viewEnd = viewport?.end || displayDuration
  const xAt = seconds => Math.max(0, Math.min(1000, (seconds - viewStart) / (viewEnd - viewStart) * 1000))
  const wavePoints = useMemo(() => {
    if (!peaks.length || !recording?.duration) return ''
    const points = []
    for (let i = 0; i < peaks.length; i++) {
      const seconds = waveInfo.from + i * waveInfo.peakSeconds
      if (seconds < viewStart || seconds > viewEnd) continue
      const x = (seconds - viewStart) / (viewEnd - viewStart) * 1000
      points.push(`${x.toFixed(1)},${(50 - peaks[i] * 44).toFixed(1)}`)
    }
    return points.join(' ')
  }, [peaks, recording?.duration, viewStart, viewEnd, waveInfo])
  const moveHandle = (type, seconds) => {
    if (type === 'start') setStart(Math.max(0, Math.min(Number(end) - 0.12, seconds)))
    else setEnd(Math.min(displayDuration, Math.max(Number(start) + 0.12, seconds)))
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
      <button type="button" onClick={() => void chooseFile()} disabled={Boolean(busy)}>
        {busy || '連結本機錄音並自動切段'}
      </button>
      <input ref={inputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.flac" hidden onChange={handleImport}/>
      <small>原音檔留在本機，辨識片段直接送至 Deepgram；網站只保存分析資料。支援超過三小時錄音，單份最長 12 小時，每個節目最多 5 份。</small>
      <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={() => backupRef.current?.click()}>匯入分析備份</button>
      <input ref={backupRef} type="file" accept=".subtitle-audio" hidden onChange={importBackup}/>
      {busy && jobRef.current && <button type="button" className="subtle-button" onClick={() => jobRef.current?.abort()}>停止準備</button>}
    </div>
    {!canTranscribe && <p className="recording-note">尚未設定 Deepgram 金鑰，匯入後可先手動標記片段。</p>}
    {scopeRecordings.length > 0 && <>
      <label className="recording-select">目前場次的錄音
        <select disabled={Boolean(busy)} value={scopeRecordings.some(r => r.id === selectedId) ? selectedId : ''} onChange={event => setSelectedId(event.target.value)}>
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
        {recording.source === 'local' && <div className="recording-actions">
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing} onClick={() => void chooseFile('link')}>連結原音檔供試聽</button>
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing} onClick={() => {
            void chooseFile('resume')
          }}>繼續準備／補做辨識</button>
          {recording.status === 'ready' && <button type="button" className="subtle-button" onClick={() => {
            const link = document.createElement('a')
            link.href = `${base}/${selectedId}/local/export`; link.download = `${recording.name}.subtitle-audio`; link.click()
          }}>匯出分析備份</button>}
          {audioSource && <small>本機音檔已連結</small>}
          {fileNotice && <small>{fileNotice}</small>}
        </div>}
        {recording.alignmentNotice && <p className="recording-note">{recording.alignmentNotice}</p>}
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
          {processing && <button type="button" className="subtle-button" onClick={() => act('正在停止對齊…', () =>
            mutation(`/${selectedId}/cancel`, {method: 'POST'}))}>停止對齊</button>}
          <button type="button" className="subtle-button" disabled={Boolean(busy) || recording.status !== 'ready' ||
            (activeId !== selectedId && (!recording.mappedCount || !compatible))}
            onClick={() => act('切換中…', () => mutation('/active', {method: 'PUT', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({recordingId: activeId === selectedId ? null : selectedId})}))}>
            {activeId === selectedId ? '停用音訊跟戲' : '使用此錄音跟戲'}
          </button>
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing}
            onClick={() => {
              void act('重新切段…', () => mutation(`/${selectedId}/align`, {method: 'POST'}))
            }}>{canTranscribe ? '重新自動切段' : '重新分析錄音'}</button>
          <button type="button" className="subtle-button danger-button" disabled={Boolean(busy)}
            onClick={() => {
              if (!window.confirm(`確定移除錄音「${recording.name}」與對齊標記？字幕劇本會保留。`)) return
              void act('移除中…', async () => { await mutation(`/${selectedId}`, {method: 'DELETE'}); await forgetRecording(localKey(sessionId, selectedId)).catch(() => {}); setLocalFile(null) })
            }}>移除錄音</button>
        </div>
        <div className="recording-actions">
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing} onClick={() =>
            act('重算這格附近…', () => mutation(`/${selectedId}/align`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({lineId})}))}>重算這格附近</button>
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing || !(apiKey || canAlignWithAI)} onClick={() =>
            act('AI 補對齊…', () => mutation(`/${selectedId}/align`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode: 'ai', apiKey})}))}>AI 補對齊待確認片段</button>
          <button type="button" className="subtle-button" disabled={Boolean(busy) || processing || !(apiKey || canAlignWithAI)} onClick={() =>
            act('AI 核對這格附近…', () => mutation(`/${selectedId}/align`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode: 'ai', apiKey, lineId})}))}>AI 核對這格附近</button>
        </div>
        <small>重新切段會保留人工校正。AI 使用設定中的 OpenAI 金鑰，僅送辨識文字及附近劇本，依用量計費。</small>
        {!(apiKey || canAlignWithAI) && <small>如需 AI 補對齊，請先在設定填入 OpenAI 金鑰。</small>}
        <p className="recording-note">{activeId === selectedId ? '此錄音已啟用；未確認的片段仍由文字跟戲。' : '此錄音尚未啟用，現場仍由文字跟戲。'}</p>
        {!compatible && <p className="recording-note">此錄音的語言或劇本欄與目前演出設定不同，無法啟用；請選擇對應錄音，或確認劇本欄後重新自動切段。</p>}
        {referenceAudio?.recordingId === selectedId && <p className="recording-live-status">
          音訊比對：{{loading:'載入中', listening:'等待人聲', searching:'尚未可靠定位', candidate:'核對中', verified:'已確認', error:'沿用文字跟戲'}[referenceAudio.status] || '等待收音'}
          {Number.isFinite(referenceAudio.referenceSeconds) && ` · 錄音 ${timeLabel(referenceAudio.referenceSeconds)}`}
          {Number.isFinite(referenceAudio.confidence) && ` · 聲音相似度 ${Math.round(referenceAudio.confidence * 100)}%`}
          {referenceAudio.error && ` · ${referenceAudio.error}`}
        </p>}
        <audio ref={audioRef} controls preload="metadata" src={audioSource || undefined}
          onLoadedMetadata={event => {if (Number.isFinite(event.currentTarget.duration)) setPlayerDuration(event.currentTarget.duration)}}
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
          {segment?.matchedText && <p className="recording-note">辨識對應：{segment.matchedText}</p>}
          {segment?.reviewReason && <p className="recording-note">{segment.reviewReason}</p>}
          {segment?.status === 'manual' && <div className="recording-actions"><small>此格已人工鎖定，重算時會保留。</small>
            <button type="button" className="subtle-button" disabled={Boolean(busy) || processing} onClick={() => act('解除校正鎖定…', () =>
              mutation(`/${selectedId}/segments/${encodeURIComponent(lineId)}/unlock`, {method: 'POST'}))}>解除校正鎖定</button></div>}
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
              aria-valuemin="0" aria-valuemax={displayDuration} aria-valuenow={Number(type === 'start' ? start : end)}
              onPointerDown={event => {if (processing) return; dragRef.current = type; event.currentTarget.ownerSVGElement.setPointerCapture(event.pointerId)}}
              onKeyDown={event => {
                if (!['ArrowLeft','ArrowRight'].includes(event.key)) return
                if (processing) return
                event.preventDefault(); moveHandle(type, Number(type === 'start' ? start : end) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 0.5 : 0.05))
              }}/>) }
          </svg>
          <div className="recording-actions">
            <span>{timeLabel(viewStart)} — {timeLabel(viewEnd)}</span>
            <button type="button" className="subtle-button" onClick={() => setViewport(viewport ? null : {start: Math.max(0, Number(start) - 2), end: Math.min(displayDuration, Number(end) + 2)})}>
              {viewport ? '整段錄音' : '放大片段'}
            </button>
          </div>
          <div className="recording-boundaries">
            <label>起點（秒）<input type="number" disabled={processing} min="0" max={displayDuration} step="0.01" value={start} onChange={event => setStart(event.target.value)}/></label>
            <label>終點（秒）<input type="number" disabled={processing} min="0" max={displayDuration} step="0.01" value={end} onChange={event => setEnd(event.target.value)}/></label>
          </div>
          <div className="recording-actions">
            <button type="button" className="subtle-button" onClick={() => moveHandle('start', audioRef.current?.currentTime || 0)}>播放位置設為起點</button>
            <button type="button" className="subtle-button" onClick={() => moveHandle('end', audioRef.current?.currentTime || 0)}>播放位置設為終點</button>
            <button type="button" className="subtle-button" onClick={playClip} disabled={Number(end) <= Number(start)}>試聽片段</button>
            <button type="button" onClick={handleSave} disabled={Boolean(busy) || processing || Number(end) - Number(start) < 0.12 ||
              (currentLine.type !== 'direction' && !currentLine.text?.trim())}>確認並保存範圍</button>
          </div>
        </div>}
        <RecordingTranscript recording={recording} base={base} lineId={lineId} segment={segment} audioRef={audioRef}
          playerDuration={playerDuration} visible={visible} disabled={Boolean(busy) || processing} act={act} mutation={mutation}/>
      </>}
    </>}
    {!scopeRecordings.length && <p className="recording-note">目前場次尚無參考錄音，沿用文字辨識跟戲。</p>}
    {error && <p className="recording-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>
}
