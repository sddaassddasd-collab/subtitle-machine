export const RECORDING_SAMPLE_RATE = 16000
export function chunkClock(duration, start, end) {
  const fromSample = Math.round(Math.max(0, start - 2) * RECORDING_SAMPLE_RATE)
  const toSample = Math.round(Math.min(duration, end + 2) * RECORDING_SAMPLE_RATE)
  return {sampleRate: RECORDING_SAMPLE_RATE, fromSample, sampleCount: toSample - fromSample,
    coreStartSample: Math.round(start * RECORDING_SAMPLE_RATE), coreEndSample: Math.round(end * RECORDING_SAMPLE_RATE)}
}
export function absoluteWords(words, clock, providerDuration) {
  const duration = clock.sampleCount / clock.sampleRate
  if (Number.isFinite(providerDuration) && Math.abs(providerDuration - duration) > 0.25)
    throw new Error('辨識音訊長度與實際送出的片段不同，請停止並核對原檔格式')
  const from = clock.fromSample / clock.sampleRate
  return words.map(word => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.end > duration + 0.1)
      throw new Error('辨識回傳的詞時間超出片段，請稍後重新準備')
    return {word: word.word, start: word.start + from, end: Math.min(duration, word.end) + from, confidence: word.confidence}
  })
}
