const {TEXT_SETTINGS: T} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {wordWindows} = require('./word-evidence');

function timedPhrases(event) {
  return wordWindows(event, {maximumWords: 24, minimumCharacters: 3}).map(speech =>
    ({speech, text: normalizeText(speech.text)}));
}

// A distinctive phrase at the end of the current revision can establish the
// visible cue by itself. Older phrases in the same revision are not candidates.
function findFreshForwardCue(script, from, event, hint) {
  if (script.entries[from]?.source.music) return null;
  const phrases = timedPhrases(event);
  const latestEnd = phrases.at(-1)?.speech.endMs;
  if (!Number.isFinite(latestEnd) ||
    Math.max(event.endMs, event.audioMs ?? event.endMs) - latestEnd > T.forwardCueFreshMs) return null;
  const minimumIndex = Math.max(0, from - T.nearbyBehind);
  const nearby = script.entries.slice(minimumIndex, from + T.nearbyAhead + 1);
  const barrier = nearby.findIndex((entry, offset) => offset + minimumIndex > from && entry.source.music);
  const phrasesAtEnd = phrases.filter(({speech}) => speech.endMs === latestEnd)
    .sort((a, b) => b.text.length - a.text.length);
  for (const {text, speech} of phrasesAtEnd) {
    const matches = nearby.flatMap((entry, offset) => entry.text.includes(text) ? [offset] : []);
    if (matches.length !== 1) continue;
    const [offset] = matches, index = minimumIndex + offset;
    if (index <= from || (barrier >= 0 && offset >= barrier)) continue;
    const entry = nearby[offset];
    const close = index - from <= T.catchUpAhead;
    const confirmedHint = event.isFinal && hint?.index === index && hint.confidence >= T.strongConfidence;
    const minimum = close ? T.shortAnchorEvidence : confirmedHint ? T.relocationEvidence : T.forwardMinimumMatches;
    if (text.length < minimum && (!close || text !== entry.text)) continue;
    return {index, speech, heard: text, length: entry.length, offset: entry.text.indexOf(text) + text.length,
      confidence: 1, evidence: text.length};
  }
  return null;
}

// Keep timed coverage of earlier cues for diagnostics. It never decides
// whether those cues should be displayed or whether the target may advance.
function reviewForwardCue(script, from, to, event) {
  if (!Number.isInteger(to) || to <= from + 1) return null;
  const phrases = timedPhrases(event);
  const target = phrases.filter(({text}) => script.entries[to].text.includes(text))
    .sort((a, b) => b.speech.endMs - a.speech.endMs || b.text.length - a.text.length)[0];
  if (!target) return null;

  const matches = [];
  const crossed = script.entries.slice(from, to + 1);
  for (let index = from + 1; index < to; index++) {
    const entry = script.entries[index];
    if (!entry.text || entry.source.music) continue;
    const match = phrases.filter(({text, speech}) => speech.endMs <= target.speech.startMs &&
      entry.text.includes(text) && !crossed.some((other, offset) => offset + from !== index && other.text.includes(text)))
      .sort((a, b) => b.speech.endMs - a.speech.endMs || b.text.length - a.text.length)[0];
    if (!match) continue;
    const {speech, text} = match;
    matches.push({index, startMs: speech.startMs, endMs: speech.endMs, firstWordId: speech.firstWordId,
      lastWordId: speech.lastWordId, heard: text, offset: entry.text.indexOf(text) + text.length,
      length: entry.length, coverage: text.length / entry.length, completed: text === entry.text});
  }
  return {action: 'advance', targetIndex: to, matches, target: target.speech};
}

module.exports = {findFreshForwardCue, reviewForwardCue};
