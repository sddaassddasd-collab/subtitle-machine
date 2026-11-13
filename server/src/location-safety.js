const {TEXT_SETTINGS: T} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {alignedWords} = require('./word-evidence');

function fullCue(script, best, event) {
  const target = script.entries[best?.index]?.text;
  return Boolean(target && !best.phonetic && best.confidence >= T.strongConfidence &&
    normalizeText(best.heard || event.text).includes(target));
}
function orderedCoverage(script, currentIndex, best, spans) {
  const covered = new Map(spans.map(span => [span.index, span]));
  return script.entries.slice(currentIndex, best.index).every((entry, offset) =>
    entry.source.type === 'direction' || covered.get(currentIndex + offset)?.completed);
}
function sharedFragment(script, currentIndex, index, heard) {
  const from = Math.max(0, currentIndex - T.nearbyBehind);
  return Boolean(heard && script.entries.slice(from, currentIndex + T.nearbyAhead + 1)
    .some((entry, offset) => from + offset !== index && entry.text.includes(heard)));
}
function forwardRejection(script, currentIndex, best, event, spans) {
  if (!best || best.index <= currentIndex + 1 || fullCue(script, best, event) || orderedCoverage(script, currentIndex, best, spans)) return null;
  const heard = normalizeText(best.heard || event.text);
  const shared = sharedFragment(script, currentIndex, best.index, heard);
  if (shared) return 'shared_forward_fragment';
  if (best.index - currentIndex > T.catchUpAhead &&
    ((best.matchedCharacters ?? best.evidence) < T.forwardMinimumMatches ||
      normalizeText(event.text).length < T.forwardMinimumMatches)) return 'insufficient_forward_evidence';
  return null;
}
function pauseRecovery(tracker, script, currentIndex, best, event, ambiguous) {
  const anchor = tracker.textAnchor;
  return Boolean(anchor?.literal && event.startMs >= anchor.atMs + T.pauseRecoveryAfterMs &&
    event.isFinal && alignedWords(event).length && best && !ambiguous && !best.phonetic &&
    best.index > currentIndex + 1 && best.index <= currentIndex + T.nearbyAhead &&
    best.confidence >= T.pauseRecoveryConfidence && best.evidence >= T.pauseRecoveryMatches &&
    fullCue(script, best, event) &&
    !script.entries.slice(currentIndex, best.index + 1).some(entry => entry.source.music));
}
function provisionalLocation(tracker, script, currentIndex, best, event, spans) {
  const previous = tracker.provisionalLocation;
  if (previous && event.endMs - previous.endMs > T.provisionalLocationMs) tracker.provisionalLocation = {...previous, expired: true};
  if (fullCue(script, best, event)) {tracker.provisionalLocation = null; return false;}
  if (best.index > currentIndex + T.catchUpAhead && !orderedCoverage(script, currentIndex, best, spans)) {
    tracker.provisionalLocation = {index: best.index, fromIndex: tracker.textAnchor?.index ?? currentIndex,
      itemId: event.itemId, endMs: event.endMs};
    return true;
  }
  if (tracker.provisionalLocation && best.index >= tracker.provisionalLocation.fromIndex) {
    tracker.provisionalLocation = {...tracker.provisionalLocation, index: best.index};
    return true;
  }
  return false;
}
function correctProvisional(tracker, script, currentIndex, best, event, ambiguous, speech) {
  const pending = tracker.provisionalLocation;
  const target = script.entries[best?.index]?.text;
  return Boolean(pending && pending.index === currentIndex && event.endMs - pending.endMs <= T.provisionalLocationMs &&
    best.index >= pending.fromIndex && best.index < currentIndex && event.itemId !== pending.itemId &&
    speech && speech.startMs >= pending.endMs && alignedWords(speech).length && !ambiguous && !best.phonetic &&
    best.confidence >= T.backwardConfidence && (best.matchedCharacters ?? best.evidence) >= T.pauseRecoveryMatches &&
    (best.matchedCharacters ?? best.evidence) / target.length >= T.provisionalCorrectionCoverage &&
    !script.entries.slice(best.index, currentIndex + 1).some(entry => entry.source.music));
}
module.exports = {sharedFragment, forwardRejection, pauseRecovery, provisionalLocation, correctProvisional};
