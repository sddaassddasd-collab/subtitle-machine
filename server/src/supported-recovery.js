const {TEXT_SETTINGS: T} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {alignedWords} = require('./word-evidence');
const negations = text => (text.match(/[不沒無勿別]/gu) || []).join('');
// A weak literal/phonetic candidate is only a hypothesis. A distinct, later
// timed cue must independently confirm its immediate successor before recovery.
function supportedRecovery(tracker, script, currentIndex, event, candidates) {
  const text = normalizeText(event.text), words = alignedWords(event), old = tracker.supportedRecovery;
  if (!words.length) return null;
  const sameOrigin = old && (old.fromIndex === currentIndex ||
    (currentIndex === old.fromIndex + 1 && tracker.prediction?.fromIndex === old.fromIndex));
  if (sameOrigin && event.itemId !== old.itemId &&
    event.startMs >= old.endMs && event.endMs - old.endMs <= T.supportedRecoveryTtlMs) {
    const next = script.entries[old.index + 1];
    if (next && text.length >= 3 && text === next.text &&
      !next.source.music && next.source.type !== 'direction') {
      tracker.supportedRecovery = null;
      return {index: old.index + 1, priorIndex: old.index};
    }
  }
  const anchor = tracker.textAnchor || tracker.lastLocated;
  if (!anchor || currentIndex < anchor.index || currentIndex > anchor.index + 1 ||
    event.endMs - anchor.atMs > T.recoveryTtlMs || event.startMs < anchor.atMs) return null;
  const ranked = candidates.filter(c => c.index > currentIndex + 1 && c.index <= currentIndex + T.supportedRecoveryAhead &&
    c.offset === c.length && c.confidence >= T.supportedRecoveryConfidence && c.matchedCharacters >= T.supportedRecoveryMatches &&
    negations(text) === negations(script.entries[c.index].text) &&
    !script.entries.slice(currentIndex, c.index + 1).some(e => e.source.music || e.source.type === 'direction'))
    .sort((a, b) => b.confidence - a.confidence);
  if (old?.itemId === event.itemId && !ranked.some(c => c.index === old.index))
    tracker.supportedRecovery = null;
  if (ranked[0] && (!ranked[1] || ranked[0].confidence - ranked[1].confidence >= T.minimumMargin)) {
    // Revisions never renew this hypothesis's lifetime or count as a second cue.
    if (!old || old.itemId !== event.itemId || old.index !== ranked[0].index)
      tracker.supportedRecovery = {fromIndex: currentIndex, index: ranked[0].index, itemId: event.itemId, endMs: event.endMs};
  }
  return null;
}
module.exports = {supportedRecovery};
