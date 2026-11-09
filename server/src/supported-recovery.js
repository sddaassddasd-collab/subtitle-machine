const {TEXT_SETTINGS: T} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {alignedWords, wordWindows} = require('./word-evidence');
const negations = text => (text.match(/[不沒無勿別]/gu) || []).join('');
// A weak literal/phonetic candidate is only a hypothesis. A distinct, later
// timed cue must independently confirm its immediate successor before recovery.
function expireSupportedRecovery(tracker, currentIndex, event) {
  const old = tracker.supportedRecovery;
  if (old && (event.endMs - old.endMs > T.supportedRecoveryTtlMs ||
    (currentIndex !== old.fromIndex && !(currentIndex === old.fromIndex + 1 && tracker.prediction?.fromIndex === old.fromIndex))))
    tracker.supportedRecovery = null;
}
function supportedRecovery(tracker, script, currentIndex, event, candidates, locate) {
  expireSupportedRecovery(tracker, currentIndex, event);
  const text = normalizeText(event.text), words = alignedWords(event), old = tracker.supportedRecovery;
  if (!words.length) {
    if (old?.itemId === event.itemId) tracker.supportedRecovery = null;
    return null;
  }
  const sameOrigin = old && (old.fromIndex === currentIndex ||
    (currentIndex === old.fromIndex + 1 && tracker.prediction?.fromIndex === old.fromIndex));
  if (sameOrigin && event.itemId !== old.itemId &&
    event.startMs >= old.endMs && event.endMs - old.endMs <= T.supportedRecoveryTtlMs) {
    const next = script.entries[old.index + 1];
    if (next && !next.source.music && next.source.type !== 'direction') {
      const parts = [event, ...(locate ? wordWindows(event, {maximumWords: 24, windowWords: 12, minimumCharacters: 4})
        .filter(part => event.endMs - part.endMs <= 1500).sort((a, b) => b.endMs - a.endMs).slice(0, 36) : [])];
      for (const part of parts) {
        const ranked = (part === event ? candidates : locate(part)).slice().sort((a, b) => b.confidence - a.confidence);
        const candidate = ranked[0], heard = normalizeText(part.text);
        const exact = heard.length >= 3 && heard === next.text;
        const partial = candidate && !candidate.phonetic && candidate.confidence >= T.supportedSuccessorConfidence &&
          candidate.matchedCharacters >= T.supportedSuccessorMatches && candidate.evidence >= T.supportedSuccessorMatches;
        if (candidate?.index === old.index + 1 && (exact || partial) &&
          candidate.confidence - (ranked[1]?.confidence || 0) >= T.minimumMargin &&
          negations(heard) === negations(next.text) && part.startMs >= old.endMs) {
          tracker.supportedRecovery = null;
          return {index: old.index + 1, priorIndex: old.index, speech: part, candidate};
        }
      }
    }
  }
  const anchor = tracker.textAnchor || tracker.lastLocated;
  if (!anchor || currentIndex < anchor.index || currentIndex > anchor.index + 1 ||
    event.endMs - anchor.atMs > T.recoveryTtlMs || event.startMs < anchor.atMs) return null;
  const ranked = candidates.filter(c => c.index >= currentIndex && (c.index !== currentIndex || tracker.prediction || !tracker.located) && c.index <= currentIndex + T.supportedRecoveryAhead &&
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
module.exports = {supportedRecovery, expireSupportedRecovery};
