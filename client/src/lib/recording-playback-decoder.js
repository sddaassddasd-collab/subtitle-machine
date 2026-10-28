export function openPlaybackDecoder(source) {
  const worker = new Worker(new URL('./recording-playback-worker.js', import.meta.url), {type: 'module'})
  const pending = new Map()
  let sequence = 0, closed = false
  const rejectPending = (error, type) => {
    for (const [id, call] of pending) if (!type || call.type === type) { call.reject(error); pending.delete(id) }
  }
  const call = (type, values) => new Promise((resolve, reject) => {
    if (closed) { reject(new DOMException('試聽已關閉', 'AbortError')); return }
    const id = ++sequence
    pending.set(id, {resolve, reject, type})
    worker.postMessage({id, type, ...values})
  })
  worker.onmessage = ({data}) => {
    const job = pending.get(data.id)
    if (!job) return
    pending.delete(data.id)
    if (data.error) { const error = new Error(data.error); error.name = data.name || 'Error'; job.reject(error) }
    else job.resolve(data)
  }
  worker.onerror = event => { rejectPending(new Error(event.message || '試聽解碼失敗')); worker.terminate(); closed = true }
  const ready = call('open', source)
  return {ready, decode: (start, end) => call('decode', {start, end}),
    cancel() {
      if (closed) return
      rejectPending(new DOMException('試聽位置已變更', 'AbortError'), 'decode')
      worker.postMessage({type: 'cancel'})
    },
    close() { closed = true; rejectPending(new DOMException('試聽已關閉', 'AbortError')); worker.terminate() },
  }
}
