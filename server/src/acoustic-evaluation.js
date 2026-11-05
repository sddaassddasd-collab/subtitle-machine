const {AcousticFollower, StreamingFeatures, extractFeatures} = require('./acoustic-follow');
const {ACOUSTIC_SETTINGS, FOLLOW_SETTINGS} = require('./follow-settings');

// Offline replay exercises the production streaming resampler and matcher.
// An independent live timeline is necessary to score another performance.
function evaluateAcoustic({referencePcm, livePcm, sampleRate = 24000, segments, liveTimeline = []}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid live sample rate');
  for (const pcm of [referencePcm, livePcm]) {
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) throw new Error('Expected nonempty mono PCM16LE');
  }
  if (!Array.isArray(segments) || !segments.length) throw new Error('Expected reference segments');
  const usable = segments.filter(s => Number.isInteger(s.index) && Number.isFinite(s.start) && Number.isFinite(s.end) &&
    s.start >= 0 && s.end > s.start && ['auto', 'manual', 'review'].includes(s.status));
  const matcher = new AcousticFollower(extractFeatures(referencePcm).features, usable);
  const frontend = new StreamingFeatures(sampleRate), reasons = {}, transitions = [], cues = new Map();
  let current = Math.min(...segments.map(s => s.index));
  if (!Number.isInteger(current) || current < 0) throw new Error('Expected indexed segments');
  matcher.reset(current);
  const packetSamples = Math.max(1, Math.round(sampleRate * 0.02));
  let comparisons = 0, accepted = 0;
  for (let offset = 0; offset < livePcm.length; offset += packetSamples * 2) {
    const packet = livePcm.subarray(offset, offset + packetSamples * 2);
    for (const frame of frontend.push(packet, (offset + packet.length) / 2 / sampleRate * 1000)) {
      const result = matcher.feed(frame, current);
      if (!result) continue;
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
      if (result.diagnostics?.compared) comparisons++;
      if (result.status !== 'verified') continue;
      accepted++;
      const time = result.audioEndMs / 1000;
      if (!cues.has(result.index)) cues.set(result.index, {firstVerifiedSeconds: time, confidence: result.confidence});
      if (result.index > current) {
        transitions.push({fromIndex: current, index: result.index, audioSeconds: time,
          referenceSeconds: result.referenceSeconds, confidence: result.confidence});
        current = result.index;
        matcher.advance(current);
      }
    }
  }
  const rows = segments.map(segment => {
    const verified = cues.get(segment.index), entry = transitions.find(t => t.index === segment.index);
    const expected = liveTimeline.find(t => t.index === segment.index);
    return {index: segment.index, lineId: segment.lineId, referenceStatus: segment.status,
      referenceStart: segment.start ?? null, referenceEnd: segment.end ?? null,
      usable: usable.includes(segment), verified: Boolean(verified), ...verified,
      enteredSeconds: entry?.audioSeconds ?? null,
      expectedStartSeconds: expected?.start ?? null,
      entryErrorSeconds: entry && Number.isFinite(expected?.start) ? entry.audioSeconds - expected.start : null};
  });
  return {schemaVersion: 1, mode: 'acoustic-only', sampleRate, frameMs: ACOUSTIC_SETTINGS.frameMs,
    settings: ACOUSTIC_SETTINGS, algorithms: FOLLOW_SETTINGS?.versions,
    groundTruthAvailable: liveTimeline.length > 0, comparisons, accepted, reasons, transitions, rows};
}
module.exports = {evaluateAcoustic};
