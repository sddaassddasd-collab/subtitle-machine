import {Input, ALL_FORMATS, BlobSource, AudioSampleSink} from 'mediabunny'
import {extractFeatures} from './recording-features.js'

let input, track, duration
async function fingerprint(file) {
  // A bounded-memory content hash chain: changing any block changes the identity.
  let hash = new Uint8Array(32)
  for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
    const block = await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()
    const next = new Uint8Array(64)
    next.set(hash); next.set(new Uint8Array(await crypto.subtle.digest('SHA-256', block)), 32)
    hash = new Uint8Array(await crypto.subtle.digest('SHA-256', next))
    self.postMessage({progress: Math.min(1, (offset + block.byteLength) / file.size)})
  }
  return [...hash].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function decodeChunk(start, end) {
  const from = Math.max(0, start - 2), to = Math.min(duration, end + 2)
  const first = Math.round(from * 16000), length = Math.round(to * 16000) - first
  const pcm = new Int16Array(length)
  let decoded = false
  const sink = new AudioSampleSink(track)
  for await (const sample of sink.samples(from, to)) {
    try {
      if (sample.numberOfChannels > 8 || sample.numberOfFrames * sample.numberOfChannels > 8e6)
        throw new Error('錄音聲道或解碼區塊過大，請先轉成單聲道 WAV')
      const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels)
      sample.copyTo(data, {format: 'f32', planeIndex: 0})
      const begin = Math.max(first, Math.ceil(sample.timestamp * 16000 - 1e-5))
      const last = Math.min(first + length, Math.ceil((sample.timestamp + sample.duration) * 16000 - 1e-5))
      for (let i = begin; i < last; i++) {
        const position = (i / 16000 - sample.timestamp) * sample.sampleRate
        const a = Math.max(0, Math.min(sample.numberOfFrames - 1, Math.floor(position)))
        const b = Math.min(sample.numberOfFrames - 1, a + 1), fraction = Math.max(0, position - a)
        let value = 0
        for (let channel = 0; channel < sample.numberOfChannels; channel++) {
          const left = data[a * sample.numberOfChannels + channel]
          value += left + (data[b * sample.numberOfChannels + channel] - left) * fraction
        }
        value = Math.max(-1, Math.min(1, value / sample.numberOfChannels))
        pcm[i - first] = Math.round(value * (value < 0 ? 32768 : 32767))
      }
      decoded ||= last > begin
    } finally { sample.close() }
  }
  if (!decoded) throw new Error('此片段無法解碼，請重新選取錄音或轉成 WAV')
  const core = pcm.subarray(Math.round(start * 16000) - first, Math.round(end * 16000) - first)
  const result = extractFeatures(core)
  // 100 ms peaks retain detail on long recordings; server returns a suitable
  // resolution for the visible range instead of always squeezing into 1600 bins.
  const peaks = []
  for (let offset = 0; offset < core.length; offset += 1600) {
    let peak = 0
    for (let i = offset; i < Math.min(core.length, offset + 1600); i++) peak = Math.max(peak, Math.abs(core[i]) / 32768)
    peaks.push(Math.round(peak * 10000) / 10000)
  }
  return {pcm: pcm.buffer, features: result.features, peaks, from, start, end}
}

self.onmessage = async ({data}) => {
  try {
    if (data.type === 'open') {
      input?.dispose()
      input = new Input({formats: ALL_FORMATS, source: new BlobSource(data.file, {maxCacheSize: 4 * 1024 * 1024})})
      track = await input.getPrimaryAudioTrack()
      if (!track || !await track.canDecode()) throw new Error('此瀏覽器無法逐段解碼此格式，請使用新版 Chrome／Edge，或轉成 PCM WAV')
      duration = await track.computeDuration()
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('錄音沒有可讀取的內容')
      self.postMessage({id: data.id, duration: Math.round(duration * 16000) / 16000, fingerprint: await fingerprint(data.file)})
    } else if (data.type === 'chunk') {
      const result = await decodeChunk(data.start, data.end)
      self.postMessage({id: data.id, ...result}, [result.pcm, result.features])
    }
  } catch (error) { self.postMessage({id: data.id, error: error.message || '本機錄音分析失敗'}) }
}
