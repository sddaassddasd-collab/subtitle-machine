const {createTracker, locateTranscript} = require('./auto-follow');
const {SHADOW_SETTINGS: SETTINGS, TEXT_SETTINGS: T} = require('./follow-settings');
const {randomUUID, createHash} = require('crypto');
const fields = ['id', 'text', 'type', 'role', 'music'];

// Independent cursor and history; no display callbacks, cue predictions, audio
// capture or model requests. One deferred revision per turn bounds queued work.
class ShadowFollow {
  constructor({record = () => {}, schedule = setImmediate, cancel = clearImmediate, now = Date.now} = {}) {
    this.record = record; this.schedule = schedule; this.cancel = cancel; this.now = now;
    this.generation = randomUUID();
    this.queue = []; this.timer = null; this.closed = false; this.dropped = 0;
  }
  enqueue({lines, event, display, seedIndex, streamId, gapFenceMs = -1, ignoreBeforeMs = -1}) {
    if (this.closed) return;
    if (!this.inputLines || lines.length !== this.inputLines.length ||
      lines.some((line, i) => fields.some(key => line[key] !== this.inputLines[i][key])))
      this.inputLines = lines.map(line => Object.fromEntries(fields.map(key => [key, line[key]])));
    if (this.signatureLines !== this.inputLines) {
      this.signatureLines = this.inputLines;
      this.scriptSignature = createHash('sha256').update(JSON.stringify(this.inputLines)).digest('hex');
    }
    if (this.queue.length >= SETTINGS.maximumQueue) {this.queue.shift(); this.dropped++;}
    this.queue.push({lines: this.inputLines, event: {...event, words: Array.isArray(event.words) ? event.words.map(word => ({...word})) : event.words},
      display: {...display}, scriptSignature: this.scriptSignature, seedIndex, streamId, gapFenceMs, ignoreBeforeMs, queuedAt: this.now()});
    if (!this.timer) this.timer = this.schedule(() => this.drain());
  }
  emit(data) {
    // Diagnostic storage failure must never break cue output or queue draining.
    try {Promise.resolve(this.record(data)).catch(() => {});} catch {}
  }
  drain() {
    this.timer = null;
    if (this.closed) return;
    const job = this.queue.shift(); if (!job) return;
    const startedAt = this.now();
    try {this.analyze(job, startedAt);} catch (error) {
      this.tracker = null;
      this.emit(this.base(job, {relationship: 'shadow_error', error: String(error.message || error).slice(0, 200)}));
    }
    if (this.queue.length && !this.closed) this.timer = this.schedule(() => this.drain());
  }
  base(job, data) {
    return {generation: this.generation, version: SETTINGS.version, mode: SETTINGS.mode, independentEvidence: false,
      at: job.event.receivedAt, receivedAt: job.event.receivedAt,
      scriptSignature: job.scriptSignature, revisionId: job.event.revisionId, itemId: job.event.itemId, streamId: job.streamId,
      providerStreamId: job.event.streamId, audioStartMs: job.event.startMs, audioEndMs: job.event.endMs,
      display: job.display, ...data};
  }
  analyze(job, startedAt) {
    let resetReason = null;
    const scriptChanged = this.lines !== job.lines;
    const streamChanged = this.providerStreamId !== job.event.streamId;
    const gapChanged = !streamChanged && job.gapFenceMs > (this.gapFenceMs ?? -1);
    if (!this.tracker || scriptChanged || streamChanged || gapChanged || this.dropped) {
      resetReason = this.dropped ? 'queue_overflow' : scriptChanged ? this.lines ? 'script_changed' : 'initial'
        : streamChanged ? 'provider_stream_changed' : gapChanged ? 'audio_gap' : 'shadow_restart';
      if (!Number.isInteger(this.index) || scriptChanged) this.index = job.seedIndex;
      const fence = Math.max(job.ignoreBeforeMs, job.gapFenceMs);
      this.tracker = createTracker({ignoreBeforeMs: fence});
      this.confirmedIndex = null; this.confirmedEndMs = null; this.completed = false;
    }
    const dropped = this.dropped; this.dropped = 0;
    this.lines = job.lines; this.providerStreamId = job.event.streamId; this.gapFenceMs = job.gapFenceMs;
    const result = locateTranscript(this.tracker, job.lines, this.index, {...job.event, prepareOnly: true});
    const candidate = result.candidate;
    const accepted = Number.isInteger(result.index) && !result.ignored;
    const reliable = accepted && !candidate?.locationOnly && !candidate?.weakPath && !candidate?.phonetic &&
      (candidate?.confidence >= T.strongConfidence || candidate?.pathConfirmed);
    if (accepted) {
      this.index = result.index;
      if (reliable) {
        this.confirmedIndex = result.index;
        this.confirmedEndMs = result.evidence?.endMs ?? job.event.endMs;
        this.completed = result.completed === true;
      }
    }
    let relationship = !accepted ? result.ignored ? 'ignored_evidence' : 'tracking_uncertain'
      : this.index === job.display.index ? 'aligned'
        : job.display.predicted && job.display.index === this.index + 1 ? 'awaiting_confirmation'
          : this.index > job.display.index ? 'locator_ahead' : 'display_ahead';
    if (!result.ignored && job.display.predicted && job.display.index === this.index + 1 &&
      this.confirmedIndex === this.index) relationship = 'awaiting_confirmation';
    if (job.display.source === 'live') relationship = 'live_output';
    else if (job.display.hidden) relationship = 'display_hidden';
    else if (job.display.holding) relationship = 'caption_handoff';
    this.last = this.base(job, {relationship, resetReason, droppedRevisions: dropped,
      requiresReview: reliable && job.event.isFinal === true && Math.abs(this.index - job.display.index) > 1 &&
        job.display.source === 'script' && !job.display.hidden && !job.display.holding,
      locator: {index: this.index, confirmedIndex: this.confirmedIndex, confirmedEndMs: this.confirmedEndMs,
        completed: this.completed && this.confirmedIndex === this.index, accepted, reliable,
        reason: result.reason || result.status, evidence: result.evidence || null,
        candidate: candidate ? {index: candidate.index, confidence: candidate.confidence, evidence: candidate.evidence,
          phonetic: candidate.phonetic === true, locationOnly: candidate.locationOnly === true} : null},
      queueWaitMs: Math.max(0, startedAt - job.queuedAt), processingMs: Math.max(0, this.now() - startedAt)});
    this.emit(this.last);
  }
  inheritPosition(previous) {
    if (Number.isInteger(previous?.index)) {
      this.index = previous.confirmedIndex ?? previous.index;
      this.inputLines = previous.inputLines; this.lines = previous.lines;
    }
  }
  dispose() {
    this.closed = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null; this.queue = [];
  }
}
module.exports = {ShadowFollow, SHADOW_FOLLOW_SETTINGS: SETTINGS};
