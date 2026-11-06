const {ONSET_SETTINGS: O} = require('./follow-settings');

// An onset is an estimate. Review it without inventing a confirmation, a
// completed ending, an extra visit or a second onset while text is uncertain.
class OnsetReview {
  constructor() { this.active = null; this.last = null; }
  event(status, data = {}) {
    const value = {...this.active, ...data, status};
    this.last = value;
    return value;
  }
  start(index, decisionId, onsetMs, audioMs) {
    const events = this.close('replaced');
    this.active = {index, decisionId, onsetMs,
      startedAudioMs: Number.isFinite(audioMs) ? audioMs : onsetMs, timedOut: false};
    events.push(this.event('pending'));
    return events;
  }
  close(reason, targetIndex = null) {
    if (!this.active) return [];
    const event = this.event('unconfirmed', {reason, targetIndex});
    this.active = null;
    return [event];
  }
  observe(currentIndex, audioMs, result = {}, speech = {}) {
    const p = this.active;
    if (!p) return [];
    if (result.reason) p.lastReason = result.reason;
    if (result.candidate) p.lastCandidate = {index: result.candidate.index, confidence: result.candidate.confidence};
    const covered = !result.ignored && result.spans?.find(s => s.index === p.index);
    if (!result.ignored && (result.index === p.index || covered)) {
      const event = this.event('confirmed', {reason: covered ? 'covered_before_advance' : result.reason || 'text_verified',
        itemId: speech.itemId, audioStartMs: result.evidence?.startMs ?? speech.startMs,
        audioEndMs: result.evidence?.endMs ?? speech.endMs, targetIndex: result.index,
        reviewedAfterMs: Math.max(0, audioMs - p.startedAudioMs)});
      this.active = null;
      return [event];
    }
    if ((!result.ignored && Number.isInteger(result.index) && result.index !== p.index) || currentIndex !== p.index)
      return this.close('position_changed_without_confirmation', result.index ?? currentIndex);
    if (!p.timedOut && audioMs - p.startedAudioMs >= O.reviewAfterMs) {
      p.timedOut = true;
      return [this.event('overdue', {reason: 'no_text_confirmation', reviewedAfterMs: audioMs - p.startedAudioMs})];
    }
    return [];
  }
}

module.exports = {OnsetReview};
