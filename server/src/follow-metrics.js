const {DIAGNOSTIC_SETTINGS: D, ACOUSTIC_SETTINGS: A} = require('./follow-settings');
const increment = (map, key) => { if (key) map[key] = (map[key] || 0) + 1; };
class AcousticSummary {
  constructor(at) {
    this.data = {fromAt: at, toAt: at, observations: 0, comparisons: 0, thresholdPasses: 0, marginPasses: 0,
      accepted: 0, maxConfidence: null, candidateSwitches: 0, maxSupport: 0, reasons: {}, supportBreaks: {}, candidates: {}};
    this.lastCandidate = null;
  }
  add(at, reason, value) {
    const data = this.data, acoustic = value.acoustic || {};
    data.toAt = at; data.observations++; increment(data.reasons, reason);
    if (acoustic.compared !== false && Number.isFinite(value.confidence)) {
      data.comparisons++;
      data.maxConfidence = Math.max(data.maxConfidence ?? 0, value.confidence);
      if (value.confidence >= (acoustic.minimumConfidence ?? A.minimumConfidence)) data.thresholdPasses++;
      if (Number.isInteger(value.candidateIndex) && (acoustic.margin === null || acoustic.margin >= (acoustic.minimumMargin ?? A.minimumMargin))) data.marginPasses++;
    }
    if (value.accepted) data.accepted++;
    data.maxSupport = Math.max(data.maxSupport, acoustic.supportCount || 0);
    increment(data.supportBreaks, acoustic.supportResetReason);
    if (Number.isInteger(value.candidateIndex)) {
      const index = String(value.candidateIndex);
      if (this.lastCandidate !== null && this.lastCandidate !== index) data.candidateSwitches++;
      this.lastCandidate = index;
      if (Object.keys(data.candidates).length < 24 || data.candidates[index]) increment(data.candidates, index);
      else increment(data.candidates, 'other');
    }
  }
  due(at) { return at - this.data.fromAt >= D.summaryMs; }
}

class CaptureSummary {
  constructor(at, streamId, previous) {
    this.data = {streamId, fromAt: at, toAt: at, packets: 0, duplicates: 0, missingSequences: 0,
      stalePackets: 0, queuedPackets: 0, droppedPackets: 0, quietPackets: 0, clippedPackets: 0,
      clippedSamples: 0, reportedSamples: 0, qualityPackets: 0, maxPeak: null, minLevel: null, maxLevel: null,
      maxReceiveGapMs: 0, maxClientAgeMs: null, drops: {}};
    const same = Boolean(previous && previous.data.streamId === streamId);
    this.lastSequence = same ? previous.lastSequence : null; this.lastAt = same ? previous.lastAt : null;
  }
  add(at, packet) {
    const data = this.data;
    data.packets++; data.toAt = at;
    if (Number.isSafeInteger(packet.sequence)) {
      if (this.lastSequence !== null && packet.sequence <= this.lastSequence) data.duplicates++;
      else {
        if (this.lastSequence !== null) data.missingSequences += Math.max(0, packet.sequence - this.lastSequence - 1);
        this.lastSequence = packet.sequence;
      }
    }
    if (this.lastAt !== null) data.maxReceiveGapMs = Math.max(data.maxReceiveGapMs, at - this.lastAt);
    this.lastAt = at;
    if (packet.stale) data.stalePackets++;
    if (packet.queued) data.queuedPackets++;
    if (Number.isFinite(packet.level)) {
      data.minLevel = Math.min(data.minLevel ?? 1, packet.level); data.maxLevel = Math.max(data.maxLevel ?? 0, packet.level);
      if (packet.level < 0.003) data.quietPackets++;
    }
    const q = packet.quality;
    if (q && Number.isFinite(q.peak) && q.peak >= 0 && q.peak <= 10 &&
      Number.isSafeInteger(q.samples) && q.samples > 0 && q.samples <= 24000 &&
      Number.isSafeInteger(q.clippedSamples) && q.clippedSamples >= 0 && q.clippedSamples <= q.samples) {
      data.qualityPackets++; data.reportedSamples += q.samples; data.clippedSamples += q.clippedSamples;
      if (q.clippedSamples) data.clippedPackets++;
      data.maxPeak = Math.max(data.maxPeak ?? 0, q.peak);
    }
    if (Number.isFinite(packet.clientAgeMs) && packet.clientAgeMs >= 0 && packet.clientAgeMs <= 600000)
      data.maxClientAgeMs = Math.max(data.maxClientAgeMs ?? 0, packet.clientAgeMs);
  }
  drop(reason, count) { this.data.droppedPackets += count; this.data.drops[reason] = (this.data.drops[reason] || 0) + count; }
  due(at) { return at - this.data.fromAt >= D.summaryMs; }
}
module.exports = {AcousticSummary, CaptureSummary};
