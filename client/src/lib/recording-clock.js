export const RECORDING_SAMPLE_RATE = 16000
export function chunkClock(duration, start, end) {
  const fromSample = Math.round(Math.max(0, start - 2) * RECORDING_SAMPLE_RATE)
  const toSample = Math.round(Math.min(duration, end + 2) * RECORDING_SAMPLE_RATE)
  return {sampleRate: RECORDING_SAMPLE_RATE, fromSample, sampleCount: toSample - fromSample,
    coreStartSample: Math.round(start * RECORDING_SAMPLE_RATE), coreEndSample: Math.round(end * RECORDING_SAMPLE_RATE)}
}
export function absoluteWords(words, clock, providerDuration, context = {}) {
  const duration = clock.sampleCount / clock.sampleRate
  const from = clock.fromSample / clock.sampleRate
  const seconds = value => Number.isFinite(value) ? `${Math.round(value * 1000000) / 1000000} 秒` : '無效時間'
  const batch = Number.isInteger(context.chunkIndex) ? `第 ${context.chunkIndex + 1}${context.chunkCount ? `／${context.chunkCount}` : ''} 段` : '此片段'
  const fail = (reason, index, word) => {
    const details = index === undefined ? '' : `，第 ${index + 1} 個詞（起點 ${seconds(word?.start)}、終點 ${seconds(word?.end)}）`
    const error = new Error(`${batch}${details}：${reason}。片段長度 ${seconds(duration)}，對應原音 ${seconds(from)}～${seconds(from + duration)}；已停止，未套用此段對齊結果`)
    error.code = 'RECORDING_WORD_TIMING'
    throw error
  }
  if (Number.isFinite(providerDuration) && Math.abs(providerDuration - duration) > 0.25)
    fail(`辨識服務回報長度 ${seconds(providerDuration)}，與實際送出的音訊不同`)
  return words.map((word, index) => {
    if (typeof word?.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end))
      fail('辨識詞缺少有效文字或時間', index, word)
    if (word.start < 0) fail('辨識詞起點早於片段開頭', index, word)
    if (word.end < word.start) fail('辨識詞終點早於起點', index, word)
    if (word.end > duration + 0.1) fail('辨識回傳的詞時間超出片段', index, word)
    // A point timestamp has text but no usable duration. Preserve it for text
    // alignment/review; do not invent a duration or shift subsequent words.
    const start = Math.min(duration, word.start), end = Math.min(duration, word.end)
    return {word: word.word, start: start + from, end: end + from, confidence: word.confidence,
      ...(end === start || start !== word.start || end !== word.end ? {timingUncertain: true} : {})}
  })
}
