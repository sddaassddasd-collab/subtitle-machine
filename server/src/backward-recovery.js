const {TEXT_SETTINGS: T} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {alignedWords, suffixSpeech} = require('./word-evidence');
const {preservedSpeech} = require('./return-evidence');

function expireBackwardRecovery(tracker, currentIndex, event) {
  const old = tracker.backwardRecovery;
  if (old && (currentIndex !== old.fromIndex || event.endMs - old.endMs > T.backwardSupportMs ||
    (event.itemId === old.itemId && !preservedSpeech(event, old)))) tracker.backwardRecovery = null;
}

// Finalization and repeated revisions are still one observation. Only a new,
// nonoverlapping utterance on the earlier path can authorize a distant rewind.
function backwardRecovery(tracker, script, currentIndex, event, best, ambiguous) {
  expireBackwardRecovery(tracker, currentIndex, event);
  if (!best || best.index >= currentIndex - T.nearbyBehind) return null;
  const old = tracker.backwardRecovery;
  const speech = suffixSpeech(event, best.heard || event.text);
  const timed = speech && alignedWords(speech).length;
  const strong = !ambiguous && !best.phonetic && !best.context &&
    best.confidence >= T.backwardConfidence && best.evidence >= T.backwardEvidence;
  const supported = strong && timed && old && best.index === old.index + 1 &&
    event.itemId !== old.itemId && speech.startMs >= old.endMs &&
    speech.endMs > old.endMs &&
    !script.entries.slice(old.index, best.index + 1).some(e => e.source.music || e.source.type === 'direction');
  if (supported) {
    tracker.backwardRecovery = null;
    return {allowed: true, supportingIndex: old.index, speech};
  }
  if (strong && timed && best.offset >= best.length - 1 &&
    !script.entries[best.index].source.music && script.entries[best.index].source.type !== 'direction' &&
    (!old || old.itemId !== event.itemId || old.index !== best.index)) {
    tracker.backwardRecovery = {fromIndex: currentIndex, index: best.index, itemId: event.itemId,
      text: normalizeText(speech.text), rawText: speech.text, startMs: speech.startMs, endMs: speech.endMs};
  }
  return {allowed: false};
}
module.exports = {backwardRecovery, expireBackwardRecovery};
