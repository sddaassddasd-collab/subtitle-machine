import {openRecordingWorker, rememberRecording, checkpoint, clearCheckpoint, wavBlob, analysisBlob} from './local-recordings.js'

export const localKey = (sessionId, recordingId) => `${sessionId}:${recordingId}`
export async function recordingJSON(url, options = {}) {
  const response = await fetch(url, options)
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || `錄音操作失敗（${response.status}）`)
  return result
}
const post = (url, body, signal) => recordingJSON(url, {method: 'POST', signal,
  headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})

export async function linkLocalRecording({entry, sessionId, recording, signal, onProgress}) {
  const worker = openRecordingWorker(entry.file, progress => onProgress(`核對音檔 ${Math.round(progress * 100)}%`), signal)
  try {
    const info = await worker.ready()
    if (info.fingerprint !== recording.fingerprint || entry.file.size !== recording.byteLength)
      throw new Error('選取的音檔與原分析結果不同，請選取原音檔；新版錄音請另外匯入')
    let remembered = true
    try { await rememberRecording(localKey(sessionId, recording.id), {...entry, fingerprint: info.fingerprint}) }
    catch { remembered = false }
    return {...entry, fingerprint: info.fingerprint, remembered}
  } finally { worker.close() }
}

async function transcribe(base, recording, pcm, from, signal, auth, retry = true) {
  if (!auth.token || auth.expiresAt < Date.now() + 15000) {
    const grant = await post(`${base}/${recording.id}/local/token`, {}, signal)
    auth.token = grant.token; auth.expiresAt = Date.now() + grant.expiresIn * 1000
  }
  const query = new URLSearchParams({model: 'nova-3', language: recording.language, punctuate: 'true',
    smart_format: 'true', mip_opt_out: 'true', tag: `reference-${recording.id}`})
  const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {method: 'POST',
    credentials: 'omit', headers: {Authorization: `Bearer ${auth.token}`, 'Content-Type': 'audio/wav'},
    body: wavBlob(pcm), signal: AbortSignal.any([signal, AbortSignal.timeout(600000)])})
  if (response.status === 401 && retry) {
    auth.token = null
    return transcribe(base, recording, pcm, from, signal, auth, false)
  }
  if (!response.ok) throw new Error(`Deepgram 片段辨識失敗（${response.status}），已保存的片段不必重跑，請稍後繼續`)
  const result = await response.json()
  const alternative = result.results?.channels?.[0]?.alternatives?.[0]
  if (!alternative || !Array.isArray(alternative.words)) throw new Error('Deepgram 未回傳有效片段結果，請稍後繼續')
  return alternative.words.map(word => ({word: word.word, start: word.start + from, end: word.end + from, confidence: word.confidence}))
}

export async function prepareLocalRecording({entry, sessionId, cellId, language, existing,
  onRecording, onProgress, onNotice, signal}) {
  const worker = openRecordingWorker(entry.file, progress => onProgress(`核對音檔 ${Math.round(progress * 100)}%`), signal)
  const base = `/api/session/${encodeURIComponent(sessionId)}/recordings`
  try {
    const info = await worker.ready()
    if (info.duration > 12 * 3600) throw new Error('單份錄音最長 12 小時，請依場次分開匯入')
    if (existing && (existing.fingerprint !== info.fingerprint || existing.byteLength !== entry.file.size))
      throw new Error('選取的音檔與此份分析資料不同，請連結原音檔，或另外匯入新版錄音')
    const recording = existing || (await post(`${base}/local`, {name: entry.file.name, originalName: entry.file.name,
      mime: entry.file.type, byteLength: entry.file.size, duration: info.duration, fingerprint: info.fingerprint, cellId, language}, signal)).recording
    const key = localKey(sessionId, recording.id)
    try { await rememberRecording(key, {...entry, fingerprint: info.fingerprint}) }
    catch { onNotice('本機儲存空間不足或權限受限；本次仍可使用，重開網站時可能需要重新連結音檔。') }
    onRecording(recording, {...entry, fingerprint: info.fingerprint})
    // Importing the same file again links it without discarding manual edits.
    if (!existing && recording.status === 'ready') return
    const state = await recordingJSON(`${base}/${recording.id}/local/state`, {signal})
    const completed = new Map(state.completed.map(chunk => [chunk.index, chunk]))
    if (recording.status === 'ready' && state.aggregateReady && (!state.canTranscribe || state.transcribed)) return
    const cacheKey = `${key}:${state.localRevision}`
    const auth = {}
    for (let index = 0; index < state.total; index++) {
      if (signal.aborted) throw new DOMException('已停止', 'AbortError')
      const saved = completed.get(index)
      if (saved && (!state.canTranscribe || saved.transcribed)) continue
      const start = index * state.chunkSeconds, end = Math.min(recording.duration, start + state.chunkSeconds)
      onProgress(`準備片段 ${index + 1}／${state.total}`)
      let pending = await checkpoint(cacheKey, index).catch(() => null)
      if (pending && (pending.metadata.fingerprint !== recording.fingerprint || (state.canTranscribe && !pending.metadata.transcribed))) pending = null
      if (!pending) {
        const chunk = await worker.chunk(start, end)
        let words = []
        if (state.canTranscribe) {
          onProgress(`辨識片段 ${index + 1}／${state.total}`)
          words = await transcribe(base, recording, chunk.pcm, chunk.from, signal, auth)
        }
        pending = {features: chunk.features, metadata: {fingerprint: recording.fingerprint, language: recording.language,
          localRevision: state.localRevision, transcribed: state.canTranscribe, words, peaks: chunk.peaks}}
        await checkpoint(cacheKey, index, pending).catch(() => {})
      }
      onProgress(`保存片段 ${index + 1}／${state.total}`)
      await recordingJSON(`${base}/${recording.id}/local/chunks/${index}`, {method: 'PUT', signal,
        headers: {'Content-Type': 'application/octet-stream'}, body: analysisBlob(pending.metadata, pending.features)})
      await clearCheckpoint(cacheKey, index).catch(() => {})
    }
    onProgress('片段已完成，正在對齊劇本…')
    await post(`${base}/${recording.id}/local/finish`, {}, signal)
  } finally { worker.close() }
}
