import {AudioSampleSink} from 'mediabunny'

// Both analysis and audition place decoded samples on this absolute sample clock.
// Decoder preroll is discarded here, never counted as part of the requested range.
export async function readRecordingPcm(track, clock, {channels = 1, float = false, signal} = {}) {
  const {fromSample: first, sampleCount: length, sampleRate} = clock
  const output = Array.from({length: channels}, () => float ? new Float32Array(length) : new Int16Array(length))
  const sink = new AudioSampleSink(track)
  let decoded = false
  signal?.throwIfAborted()
  for await (const sample of sink.samples(first / sampleRate, (first + length) / sampleRate)) {
    try {
      signal?.throwIfAborted()
      if (sample.numberOfChannels > 8 || sample.numberOfFrames * sample.numberOfChannels > 8e6)
        throw new Error('錄音聲道或解碼區塊過大，請先轉成單聲道 WAV')
      const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels)
      sample.copyTo(data, {format: 'f32', planeIndex: 0})
      const begin = Math.max(first, Math.ceil(sample.timestamp * sampleRate - 1e-5))
      const last = Math.min(first + length, Math.ceil((sample.timestamp + sample.duration) * sampleRate - 1e-5))
      for (let i = begin; i < last; i++) {
        const position = (i / sampleRate - sample.timestamp) * sample.sampleRate
        const a = Math.max(0, Math.min(sample.numberOfFrames - 1, Math.floor(position)))
        const b = Math.min(sample.numberOfFrames - 1, a + 1), fraction = Math.max(0, position - a)
        for (let channel = 0; channel < channels; channel++) {
          let value = 0
          const mix = channels === 1
          for (let source = mix ? 0 : channel; source < (mix ? sample.numberOfChannels : channel + 1); source++) {
            const left = data[a * sample.numberOfChannels + source]
            value += left + (data[b * sample.numberOfChannels + source] - left) * fraction
          }
          value = Math.max(-1, Math.min(1, value / (mix ? sample.numberOfChannels : 1)))
          output[channel][i - first] = float ? value : Math.round(value * (value < 0 ? 32768 : 32767))
        }
      }
      decoded ||= last > begin
    } finally { sample.close() }
  }
  signal?.throwIfAborted()
  if (!decoded) throw new Error('此片段無法解碼，請重新連結錄音或轉成 WAV')
  return output
}
