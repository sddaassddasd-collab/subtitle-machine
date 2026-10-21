// File handles and optional fallback copies stay in this browser, never in the
// session snapshot. A different device only needs them for playback/reanalysis.
let database
const memory = new Map()
async function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('subtitle-local-recordings', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}
async function stored(key, value, remove = false) {
  const connection = await db()
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction('files', value === undefined && !remove ? 'readonly' : 'readwrite')
    const store = transaction.objectStore('files')
    const request = remove ? store.delete(key) : value === undefined ? store.get(key) : store.put(value, key)
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('無法保存本機錄音資料'))
  })
}
export async function pickRecording() {
  if (!window.showOpenFilePicker) return null
  const [handle] = await window.showOpenFilePicker({multiple: false, types: [{description: '錄音', accept: {
    'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.webm'],
  }}]})
  return {file: await handle.getFile(), handle}
}
export async function rememberRecording(key, entry) {
  entry = {...entry, size: entry.file.size, lastModified: entry.file.lastModified}
  memory.set(key, entry)
  // Browsers without handles retain a disk-backed Blob copy for next visit.
  const identity = {fingerprint: entry.fingerprint, size: entry.file.size, lastModified: entry.file.lastModified}
  await stored(key, {...identity, ...(entry.handle ? {handle: entry.handle} : {file: entry.file})})
  await navigator.storage?.persist?.().catch(() => false)
}
export async function recallRecording(key, ask = false) {
  const entry = memory.get(key) || await stored(key)
  if (!entry) return null
  if (!entry.handle) return entry.file ? entry : null
  let permission = await entry.handle.queryPermission({mode: 'read'})
  if (permission !== 'granted' && ask) permission = await entry.handle.requestPermission({mode: 'read'})
  if (permission !== 'granted') return null
  const result = {...entry, file: await entry.handle.getFile()}
  memory.set(key, result)
  return result
}
async function forgetMatching(key, includeExact) {
  const matches = value => (includeExact && value === key) || String(value).startsWith(`${key}:`)
  for (const value of memory.keys()) if (matches(value)) memory.delete(value)
  const connection = await db()
  await new Promise((resolve, reject) => {
    const transaction = connection.transaction('files', 'readwrite'), store = transaction.objectStore('files')
    const request = store.openKeyCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      if (matches(cursor.key)) store.delete(cursor.primaryKey)
      cursor.continue()
    }
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
export const forgetRecording = key => forgetMatching(key, true)
export const forgetLocalSession = sessionId => forgetMatching(sessionId, false)
export const checkpoint = (key, index, value) => stored(`${key}:chunk:${index}`, value)
export const clearCheckpoint = (key, index) => stored(`${key}:chunk:${index}`, undefined, true)

export function openRecordingWorker(file, onProgress, signal) {
  const worker = new Worker(new URL('./local-recording-worker.js', import.meta.url), {type: 'module'})
  let sequence = 0
  const pending = new Map()
  const stop = () => {
    worker.terminate()
    for (const {reject} of pending.values()) reject(new DOMException('錄音準備已停止，可稍後繼續', 'AbortError'))
    pending.clear()
  }
  signal?.addEventListener('abort', stop, {once: true})
  worker.onmessage = ({data}) => {
    if (data.progress !== undefined) { onProgress(data.progress); return }
    const call = pending.get(data.id)
    if (!call) return
    pending.delete(data.id)
    if (data.error) call.reject(new Error(data.error)); else call.resolve(data)
  }
  worker.onerror = event => {
    for (const {reject} of pending.values()) reject(new Error(event.message || '本機錄音分析失敗'))
    pending.clear()
    worker.terminate()
  }
  const call = (type, values = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已停止', 'AbortError')); return }
    const id = ++sequence
    pending.set(id, {resolve, reject})
    worker.postMessage({id, type, ...values})
  })
  return {ready: () => call('open', {file}), chunk: (start, end) => call('chunk', {start, end}),
    close: () => { signal?.removeEventListener('abort', stop); stop() }}
}

export function wavBlob(pcm) {
  const header = new ArrayBuffer(44), view = new DataView(header)
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  return new Blob([header, pcm], {type: 'audio/wav'})
}

export function analysisBlob(metadata, features) {
  const json = new TextEncoder().encode(JSON.stringify(metadata)), header = new ArrayBuffer(4)
  new DataView(header).setUint32(0, json.length, true)
  return new Blob([header, json, features], {type: 'application/octet-stream'})
}
