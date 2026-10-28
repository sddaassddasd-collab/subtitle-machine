import {useCallback, useEffect, useState} from 'react'
import {recordingJSON} from '../lib/local-recording-client'

const time = seconds => {
  const value = Math.max(0, Number(seconds) || 0)
  return `${Math.floor(value / 3600) ? `${Math.floor(value / 3600)}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}`
}

export default function RecordingTranscript({recording, base, lineId, segment, audioRef, playerDuration, visible, disabled, act, mutation}) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [error, setError] = useState('')
  const [location, setLocation] = useState({}), [selectedId, setSelectedId] = useState(null)
  const [anchors, setAnchors] = useState([])
  const calibratedFeatures = Boolean(recording.featureCalibration)
  const [applyToFeatures, setApplyToFeatures] = useState(calibratedFeatures)
  const calibrationKey = JSON.stringify(recording.timeCalibration?.anchors || [])
  useEffect(() => { setAnchors(JSON.parse(calibrationKey)) }, [recording.id, calibrationKey])
  useEffect(() => { setApplyToFeatures(calibratedFeatures) }, [recording.id, calibratedFeatures])
  useEffect(() => { setLocation({}); setSelectedId(null); setData(null) }, [recording.id, lineId])
  const load = useCallback(async signal => {
    const query = new URLSearchParams({lineId, ...location})
    if (Number.isFinite(playerDuration)) query.set('playerDuration', playerDuration)
    const value = await recordingJSON(`${base}/${recording.id}/transcript?${query}`, {signal})
    if (signal?.aborted) return
    setData(value); setError('')
  }, [base, recording.id, lineId, location, playerDuration])
  useEffect(() => {
    if (!open || !visible || recording.status !== 'ready') return
    const abort = new AbortController()
    load(abort.signal).catch(error => {if (error.name !== 'AbortError') setError(error.message)})
    return () => abort.abort()
  }, [load, open, visible, recording.status, recording.revision])
  const selected = data?.words.find(word => word.id === selectedId)
  const seek = word => {
    setSelectedId(word.id)
    if (audioRef.current?.src) audioRef.current.currentTime = Math.max(0, word.start)
  }
  const addAnchor = () => {
    const audio = audioRef.current
    if (!selected || !audio?.src || !Number.isFinite(audio.currentTime)) return
    setAnchors(previous => [...previous.filter(anchor => anchor.wordId !== selected.id || anchor.edge !== 'start'),
      {wordId: selected.id, edge: 'start', time: Math.round(audio.currentTime * 1000) / 1000}].slice(-12))
  }
  const apply = values => act('校正時間並重新對齊…', async () => {
    await mutation(`/${recording.id}/timing`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({anchors: values, applyToFeatures, playerDuration: playerDuration || recording.playbackDuration || recording.duration})})
  })
  return <details className="recording-transcript" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>辨識原文與時間核對</summary>
    <p className="recording-note">點辨識詞可定位原檔。先核對開頭、中間、結尾與五分鐘交界，再校正時間。</p>
    <div className="recording-actions">
      <button type="button" className="subtle-button" onClick={() => setLocation({})}>這格附近</button>
      <button type="button" className="subtle-button" onClick={() => setLocation({at: audioRef.current?.currentTime || 0})}>目前播放位置</button>
      <button type="button" className="subtle-button" disabled={data?.previousOffset == null} onClick={() => setLocation({offset: data.previousOffset})}>較早的辨識</button>
      <button type="button" className="subtle-button" disabled={data?.nextOffset == null} onClick={() => setLocation({offset: data.nextOffset})}>較晚的辨識</button>
    </div>
    {data && <>
      <p className="recording-note">分析總長 {time(data.diagnostics.analysisDuration)} · 原檔播放總長 {time(playerDuration || data.diagnostics.playerDuration)}
        {data.diagnostics.chunks > 0 && ` · 已核對 ${data.diagnostics.chunks} 段音訊長度`}</p>
      {data.diagnostics.issues.map(issue => <p className="recording-note" key={issue}>{issue}</p>)}
      <div className="recording-words" aria-label="辨識原文">
        {data.words.map(word => <button type="button" key={word.id}
          className={`${selectedId === word.id ? 'selected' : ''} ${word.id >= segment?.wordStart && word.id <= segment?.wordEnd ? 'mapped' : ''}`}
          title={`詞 ${word.id} · ${time(word.start)}～${time(word.end)} · 原辨識 ${time(word.rawStart)}${word.timingUncertain ? ' · 時間待確認' : ''}`}
          onClick={() => seek(word)}><span>{word.word}</span><small>{time(word.start)}</small></button>)}
        {!data.words.length && <p>這份錄音尚無辨識文字。</p>}
      </div>
      {selected && <p>詞 {selected.id}「{selected.word}」：原辨識 {time(selected.rawStart)}～{time(selected.rawEnd)}；播放位置 {time(selected.start)}～{time(selected.end)}</p>}
      {selected?.timingUncertain && <p className="recording-note">此詞沒有可靠的起終時間，相關字幕需試聽確認。</p>}
    </>}
    <p className="recording-note">一個定位點校正固定偏移；兩個以上校正時間比例，建議用第三點驗證。選好辨識詞後，在原檔聽到該詞起音的位置暫停，再加入定位點。</p>
    <button type="button" className="subtle-button" disabled={disabled || !selected || !audioRef.current?.src} onClick={addAnchor}>以目前播放位置校正選定詞</button>
    {anchors.map((anchor, index) => <div className="recording-anchor" key={`${anchor.wordId}:${anchor.edge}`}>
      <label>詞 {anchor.wordId} 的實際起點（秒）<input type="number" min="0" step="0.01" disabled={disabled} value={anchor.time}
        onChange={event => setAnchors(previous => previous.map((value, i) => i === index ? {...value, time: Number(event.target.value)} : value))}/></label>
      <button type="button" className="subtle-button" disabled={disabled} onClick={() => setAnchors(previous => previous.filter((_, i) => i !== index))}>移除定位點</button>
    </div>)}
    {recording.timeCalibration && <p className="recording-note">時間比例 {recording.timeCalibration.scale.toFixed(6)} · 固定偏移 {recording.timeCalibration.offset.toFixed(3)} 秒</p>}
    <label className="recording-note"><input type="checkbox" disabled={disabled} checked={applyToFeatures} onChange={event => setApplyToFeatures(event.target.checked)}/>
      波形也與播放位置偏移，一併校正波形與聲音比對</label>
    <div className="recording-actions">
      <button type="button" disabled={disabled || !anchors.length} onClick={() => apply(anchors)}>套用時間校正並重算</button>
      <button type="button" className="subtle-button" disabled={disabled || !recording.timeCalibration} onClick={() => apply([])}>恢復原辨識時間</button>
    </div>
    <small>原始辨識時間會保留；已人工確認的片段不會移動。若各處偏移不一致，請逐段核對，勿套用整體校正。</small>
    {error && <p className="recording-error">{error}</p>}
  </details>
}
