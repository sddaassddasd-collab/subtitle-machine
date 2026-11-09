const {normalizeText} = require('./follow-text');
const {alignedWords} = require('./word-evidence');
const {TEXT_SETTINGS: T} = require('./follow-settings');
const negations = text => (text.match(/[不沒無勿別]/gu) || []).join('');

// Count ordered literal islands, rather than treating inserted/paraphrased words
// as evidence. Single shared characters cannot establish a phrase anchor.
function phraseEvidence(heard, target) {
  const dp = Array.from({length: heard.length + 1}, () => new Uint16Array(target.length + 1));
  for (let i = heard.length - 1; i >= 0; i--) for (let j = target.length - 1; j >= 0; j--)
    dp[i][j] = heard[i] === target[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const runs = []; let i = 0, j = 0, run = 0;
  const flush = () => {if (run >= T.phraseRecoveryIsland) runs.push(run); run = 0;};
  while (i < heard.length && j < target.length) {
    if (heard[i] === target[j]) {run++; i++; j++;}
    else {flush(); if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;}
  }
  flush();
  return {matched: runs.reduce((a, b) => a + b, 0), islands: runs.length};
}

function phraseRecovery(tracker, script, currentIndex, event) {
  const anchor = tracker.textAnchor, text = normalizeText(event.text);
  if (!event.isFinal || !alignedWords(event).length || !anchor ||
    currentIndex < anchor.index || currentIndex > anchor.index + 1 ||
    event.startMs < anchor.atMs || event.endMs - anchor.atMs > T.weakAnchorTtlMs ||
    text.length > T.maxHeard || event.endMs <= (tracker.prediction?.onsetMs ?? -1)) return null;
  const candidates = [];
  const from = Math.max(0, currentIndex - T.nearbyBehind);
  const to = Math.min(script.entries.length - 1, currentIndex + T.phraseRecoveryAhead);
  for (let index = from; index <= to; index++) {
    const entry = script.entries[index];
    if (entry.length > T.maxHeard * 2) continue;
    const {matched, islands} = phraseEvidence(text, entry.text);
    if (entry.text && negations(text) === negations(entry.text)) candidates.push({index, matched, islands,
      confidence: Math.min(matched / entry.text.length, matched / text.length)});
  }
  candidates.sort((a, b) => b.confidence - a.confidence || b.matched - a.matched);
  const best = candidates[0];
  if (!best || best.index < currentIndex || best.index < (event.minimumIndex ?? -1) ||
    best.islands < 2 || best.matched < T.phraseRecoveryMatches ||
    best.matched / script.entries[best.index].length < T.phraseRecoveryCoverage ||
    best.confidence < T.phraseRecoveryHeardCoverage ||
    best.confidence - (candidates[1]?.confidence || 0) < T.phraseRecoveryMargin ||
    script.entries.slice(currentIndex, best.index + 1).some(e => e.source.music || e.source.type === 'direction')) return null;
  return {...best, evidence: best.matched, matchedCharacters: best.matched, phraseAnchored: true,
    locationOnly: true, speech: event, heard: text, offset: 0, length: script.entries[best.index].length};
}
module.exports = {phraseRecovery, phraseEvidence};
