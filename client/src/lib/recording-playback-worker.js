import {Input, ALL_FORMATS, BlobSource, UrlSource} from 'mediabunny'
import {readRecordingPcm} from './recording-pcm.js'

let opening, track, duration, sampleRate, channels, epoch = 0, active, running = false
let queue = []
const failure = (id, error) => self.postMessage({id, error: error.message || '無法準備試聽音訊', name: error.name})

async function drain() {
  if (running) return
  running = true
  while (queue.length) {
    const job = queue.shift(), abort = new AbortController()
    active = abort
    try {
      await opening
      if (job.epoch !== epoch) throw new DOMException('試聽位置已變更', 'AbortError')
      const fromSample = Math.round(job.start * sampleRate)
      const endSample = Math.min(Math.round(duration * sampleRate), Math.round(job.end * sampleRate))
      if (fromSample < 0 || endSample <= fromSample || endSample - fromSample > sampleRate * 21)
        throw new Error('試聽片段範圍不正確')
      const clock = {fromSample, sampleCount: endSample - fromSample, sampleRate}
      const pcm = await readRecordingPcm(track, clock, {channels, float: true, signal: abort.signal})
      abort.signal.throwIfAborted()
      const buffers = pcm.map(channel => channel.buffer)
      self.postMessage({id: job.id, start: fromSample / sampleRate, sampleRate, channels: buffers}, buffers)
    } catch (error) { failure(job.id, error) }
    finally { active = null }
  }
  running = false
}

self.onmessage = ({data}) => {
  if (data.type === 'open') {
    opening = (async () => {
      const source = data.file ? new BlobSource(data.file, {maxCacheSize: 4 * 1024 * 1024})
        : new UrlSource(data.url, {maxCacheSize: 4 * 1024 * 1024, getRetryDelay: attempts => attempts < 2 ? 0.5 : null})
      const input = new Input({formats: ALL_FORMATS, source})
      track = await input.getPrimaryAudioTrack()
      if (!track || !await track.canDecode()) throw new Error('此瀏覽器無法準確解碼錄音，請使用新版 Chrome／Edge，或轉成 PCM WAV')
      duration = await track.computeDuration()
      sampleRate = Math.min(48000, await track.getSampleRate())
      channels = await track.getNumberOfChannels()
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleRate) || sampleRate < 8000 || channels < 1 || channels > 8)
        throw new Error('錄音格式或長度無法讀取')
      // Stereo is retained; uncommon multichannel recordings use the same mono mix as analysis.
      if (channels > 2) channels = 1
      self.postMessage({id: data.id, duration: Math.round(duration * sampleRate) / sampleRate, sampleRate})
    })()
    opening.catch(error => failure(data.id, error))
  } else if (data.type === 'cancel') {
    epoch++
    active?.abort()
    for (const job of queue) failure(job.id, new DOMException('試聽位置已變更', 'AbortError'))
    queue = []
  } else if (data.type === 'decode') {
    queue.push({...data, epoch})
    void drain()
  }
}
