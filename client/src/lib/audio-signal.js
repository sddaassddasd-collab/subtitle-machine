export function signalMetrics(input) {
  let sum = 0, peak = 0, clippedSamples = 0
  for (const sample of input || []) {
    sum += sample * sample
    const amplitude = Math.abs(sample)
    peak = Math.max(peak, amplitude)
    if (amplitude >= 0.99) clippedSamples++
  }
  return {level: input?.length ? Math.min(1, Math.sqrt(sum / input.length)) : 0,
    peak, clippedSamples, samples: input?.length || 0}
}
