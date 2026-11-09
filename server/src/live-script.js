const {prepareScript, localSupportCandidates} = require('./auto-follow');
const {freshSpeech, wordWindows, alignedWords} = require('./word-evidence');
const {normalizeText} = require('./follow-text');
const {TEXT_SETTINGS: T} = require('./follow-settings');

// Only raw provider text and word clocks enter the locator. Caption edits are
// display-only and never become independent script evidence.
function liveCandidates(script, window, speech, extra = {}) {
  const options = {ahead: window.to - window.origin, behind: window.origin - window.from, crossDirections: true, ...extra};
  const variants = [speech];
  const trimmed = speech.text.replace(/[呢啊呀喔哦啦嘛吧耶欸？！?！。，,\s]+$/u, '');
  if (trimmed && trimmed !== speech.text && normalizeText(speech.text).length - normalizeText(trimmed).length <= 2)
    variants.push({...speech, text: trimmed});
  const byIndex = new Map();
  for (const part of variants) for (const c of localSupportCandidates(script, window.origin, part.text, options)) {
    if (!byIndex.has(c.index) || c.confidence > byIndex.get(c.index).confidence) byIndex.set(c.index, {...c, speech: part});
  }
  return [...byIndex.values()];
}

function textSupportCandidates(speech, locate) {
  const windows = wordWindows(speech, {maximumWords: 24, windowWords: 12, minimumCharacters: 3})
    .filter(w => speech.endMs - w.endMs <= 2000)
    .sort((a, b) => b.endMs - a.endMs || b.text.length - a.text.length).slice(0, 36);
  const result = [];
  for (const part of [speech, ...windows]) {
    const candidates = locate(part).sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
    if (best) result.push({...best, speech: part, supportMargin: best.confidence - (candidates[1]?.confidence || 0)});
  }
  return result;
}

function locateLiveScript(performance, lines, transcript, options, previousScript) {
  const window = performance.searchWindow(options.receivedAt);
  const speech = freshSpeech({...options, text: transcript}, performance.lastConfirmedEnd);
  if (!speech) return {status: 'searching', reason: 'no_fresh_script_evidence', searchWindow: window};
  const script = prepareScript(lines, previousScript);
  // Inspect a bounded set of recent word ranges so a growing/final ASR item can
  // contain several cues, a filler ending, or the beginning of the next cue.
  const windows = wordWindows(speech, {maximumWords: 12, windowWords: 8})
    .filter(w => speech.endMs - w.endMs <= 1500)
    .sort((a, b) => b.endMs - a.endMs || b.text.length - a.text.length);
  const byEnd = new Map(), selected = [];
  for (const w of windows) {
    const count = byEnd.get(w.endMs) || 0;
    if (count >= 3 || (!byEnd.has(w.endMs) && byEnd.size >= 5)) continue;
    byEnd.set(w.endMs, count + 1); selected.push(w);
  }
  const pools = [speech, ...selected].map(part => {
    const byIndex = new Map();
    for (const c of liveCandidates(script, window, part, {phoneticMinimum: T.supportedRecoveryConfidence})) {
      const prior = byIndex.get(c.index);
      if (!prior || c.confidence > prior.confidence) byIndex.set(c.index, c);
    }
    const candidates = [...byIndex.values()].sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
    return best ? {...best, margin: best.confidence - (candidates[1]?.confidence || 0)} : null;
  }).filter(Boolean);
  const negations = text => (normalizeText(text).match(/[不沒無勿別]/gu) || []).join('');
  for (const candidate of pools) candidate.nearbyRecovery = Boolean(
    candidate.index > window.origin && candidate.index <= window.origin + T.supportedRecoveryAhead &&
    candidate.offset === candidate.length && candidate.confidence >= T.supportedRecoveryConfidence &&
    candidate.matchedCharacters >= T.supportedRecoveryMatches && candidate.margin >= T.minimumMargin &&
    alignedWords(candidate.speech).length &&
    negations(candidate.speech.text) === negations(lines[candidate.index].text) &&
    !lines.slice(window.origin, candidate.index + 1).some(line => line.music || line.type === 'direction'));
  const admitted = pools.filter(c => (c.evidence >= 4 && (c.nearbyRecovery ||
    (c.confidence >= .8 && c.margin >= .07 && (!c.phonetic || c.confidence >= .9)) ||
    (!c.phonetic && c.confidence >= .7 && c.matchedCharacters >= 3 && c.margin >= .1))) ||
    (!c.phonetic && c.margin >= .1 && normalizeText(c.speech.text).length >= 3 &&
      normalizeText(c.speech.text) === script.entries[c.index].text &&
      performance.returnWitnesses.some(w => w.nearbyRecovery && w.index + 1 === c.index &&
        w.itemId !== speech.itemId && c.speech.startMs >= w.endMs &&
        c.speech.endMs - w.endMs <= T.supportedRecoveryTtlMs)));
  const best = (admitted.length ? admitted : pools).sort((a, b) =>
    b.speech.endMs - a.speech.endMs || b.confidence - a.confidence || b.evidence - a.evidence)[0];
  const accepted = admitted.includes(best);
  return {status: 'searching', reason: accepted ? best.confidence >= .8 ? 'background_script_candidate' : 'background_script_provisional' : 'background_script_uncertain',
    ...(accepted ? {index: best.index} : {}), candidate: best || null, searchWindow: window,
    evidence: {startMs: best?.speech.startMs ?? speech.startMs, endMs: best?.speech.endMs ?? speech.endMs}, completed: false};
}

module.exports = {locateLiveScript, liveCandidates, textSupportCandidates};
