const crypto = require('node:crypto');
const {DIAGNOSTIC_SETTINGS: D} = require('./follow-settings');

// Only analysis results enter this ring, never PCM packets or raw audio. A
// trigger saves the preceding ring; subsequent samples are appended in chunks.
// Persisted sample IDs prevent overlapping windows duplicating the same data.
class FollowTrace {
  constructor() { this.ring = []; this.nextId = 1; this.savedThrough = 0; this.window = null; this.reasons = new Map(); this.truncated = 0; }
  observe(at, lane, reason, data) {
    const events = this.flush(at);
    const sample = {sampleId: this.nextId++, at, lane, reason, ...data};
    this.ring.push(sample);
    while (this.ring.length && this.ring[0].at < at - D.preMs) this.ring.shift();
    while (this.ring.length > D.maxRingSamples) { this.ring.shift(); this.truncated++; }
    const previous = this.reasons.get(lane);
    this.reasons.set(lane, reason);
    if (previous !== reason) events.push(...this.trigger(at, 'reason_changed', {lane, previousReason: previous ?? null, reason}));
    else if (this.window) events.push(...this.drain(at));
    return events;
  }
  trigger(at, reason, data = {}) {
    const events = this.flush(at);
    if (!this.window) this.window = {id: crypto.randomUUID(), startedAt: at, until: at + D.postMs, lastChunkAt: at};
    else this.window.until = Math.min(this.window.startedAt + D.maxWindowMs, at + D.postMs);
    events.push({...data, windowId: this.window.id, phase: 'trigger', at, reason, decisionReason: data.reason,
      preMs: D.preMs, postMs: D.postMs, truncatedSamples: this.truncated, samples: this.take()});
    this.truncated = 0;
    return events;
  }
  take() {
    const samples = this.ring.filter(sample => sample.sampleId > this.savedThrough);
    if (samples.length) this.savedThrough = samples.at(-1).sampleId;
    return samples;
  }
  drain(at, force = false) {
    if (!this.window) return [];
    const count = this.ring.filter(sample => sample.sampleId > this.savedThrough).length;
    if (!count || (!force && count < D.chunkSamples && at - this.window.lastChunkAt < D.chunkMs)) return [];
    this.window.lastChunkAt = at;
    return [{windowId: this.window.id, phase: 'after', at, samples: this.take()}];
  }
  flush(at, force = false) {
    const expired = this.window && at > this.window.until;
    const events = this.drain(at, force || expired);
    if (expired || force) this.window = null;
    return events;
  }
}

function trackerSnapshot(tracker, currentIndex) {
  return {currentIndex, located: tracker.located, progressIndex: tracker.progressIndex, progress: tracker.progress,
    armedIndex: tracker.armedIndex, preparedIndex: tracker.preparedIndex,
    prediction: tracker.prediction ? {index: tracker.prediction.index, source: tracker.prediction.source || 'onset', onsetMs: tracker.prediction.onsetMs} : null,
    sequence: tracker.sequence ? {index: tracker.sequence.index, atMs: tracker.sequence.atMs} : null,
    correction: {status: tracker.correction.status, candidates: tracker.correction.candidates.slice(0, 3)},
    referenceFence: tracker.referenceFence ? {index: tracker.referenceFence.index, audioMs: tracker.referenceFence.audioMs, decidedAudioMs: tracker.referenceFence.decidedAudioMs} : null,
    referenceProgress: tracker.referenceProgress ? {...tracker.referenceProgress} : null,
    ignoreBeforeMs: tracker.ignoreBeforeMs, latestStartMs: tracker.latestStartMs, latestOrder: tracker.latestOrder,
    quietMs: tracker.quietMs, loudMs: tracker.loudMs};
}

function transcriptDetails(text, options) {
  const raw = String(text || ''), words = Array.isArray(options.words) ? options.words : [];
  return {text: raw.slice(0, D.maxTranscriptChars), textLength: raw.length, textTruncated: raw.length > D.maxTranscriptChars,
    itemId: options.itemId ?? null, providerStreamId: options.streamId ?? null, order: options.order ?? null,
    isFinal: options.isFinal === true, speechFinal: options.speechFinal === true,
    audioStartMs: options.startMs ?? null, audioEndMs: options.endMs ?? null,
    confidence: Number.isFinite(options.confidence) ? options.confidence : null,
    providerText: typeof options.providerText === 'string' ? options.providerText.slice(0, D.maxTranscriptChars) : null,
    wordsAvailable: Array.isArray(options.words), wordCount: words.length, wordsTruncated: words.length > D.maxWords,
    words: words.slice(0, D.maxWords).map(word => ({word: String(word.word || '').slice(0, 120),
      punctuatedWord: typeof word.punctuated_word === 'string' ? word.punctuated_word.slice(0, 160) : null,
      startMs: Number.isFinite(word.start) ? word.start * 1000 : null,
      endMs: Number.isFinite(word.end) ? word.end * 1000 : null,
      confidence: Number.isFinite(word.confidence) ? word.confidence : null}))};
}

function clientMetadata(value) {
  const source = value && typeof value === 'object' ? value : {};
  const audio = source.audio && typeof source.audio === 'object' ? source.audio : {};
  return {build: {commit: String(source.build?.commit || 'unknown').slice(0, 80), builtAt: String(source.build?.builtAt || '').slice(0, 40)},
    userAgent: String(source.userAgent || '').slice(0, 400),
    audio: Object.fromEntries(['contextSampleRate', 'sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl']
      .filter(key => typeof audio[key] === 'boolean' || (Number.isFinite(audio[key]) && audio[key] >= 0))
      .map(key => [key, audio[key]]))};
}
module.exports = {FollowTrace, trackerSnapshot, transcriptDetails, clientMetadata};
