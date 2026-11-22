const {TEXT_SETTINGS: T} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {wordWindows} = require('./word-evidence');

// Use whole provider words. An ASR revision can contain the end of one cue
// and the beginning of another, so its envelope is not a cue timestamp.
function reviewForwardCue(script, from, to, event, candidate, audioMs = event.endMs) {
  if (!Number.isInteger(to) || to <= from + 1) return null;
  const intermediate = [];
  for (let index = from + 1; index < to; index++) {
    const entry = script.entries[index];
    if (entry.text && !entry.source.music) intermediate.push(index);
  }
  if (!intermediate.length) return null;

  const targetText = script.entries[to].text;
  const windows = wordWindows(event, {minimumCharacters: 1}).map(speech =>
    ({speech, text: normalizeText(speech.text)}));
  if (!windows.length) return null;
  const fromNearby = Math.max(0, from - T.nearbyBehind);
  const nearby = script.entries.slice(fromNearby, Math.min(script.entries.length, Math.max(to, from) + T.nearbyAhead + 1));
  const unique = (text, index) => !nearby.some((entry, offset) => fromNearby + offset !== index && entry.text.includes(text));
  const strongTarget = windows.filter(({text}) => targetText.includes(text) && unique(text, to) &&
    (text.length >= T.forwardMinimumMatches || (text === targetText && text.length >= 3)));
  const matches = [];
  for (const index of intermediate) {
    const entry = script.entries[index];
    const match = windows
      .filter(({text}) => entry.text.includes(text) && unique(text, index) && (text.length >= 3 || text === entry.text))
      .sort((a, b) => b.speech.endMs - a.speech.endMs || b.text.length - a.text.length)[0];
    if (!match) continue;
    const {speech, text} = match;
    matches.push({index, startMs: speech.startMs, endMs: speech.endMs, firstWordId: speech.firstWordId,
      lastWordId: speech.lastWordId, heard: text, offset: entry.text.indexOf(text) + text.length,
      length: entry.length, coverage: text.length / entry.length, completed: text === entry.text});
  }
  const latest = matches.reduce((a, b) => !a || b.endMs > a.endMs ? b : a, null);
  const longJump = intermediate.length >= T.catchUpAhead;
  const ordered = latest && windows.find(({speech, text}) => speech.startMs >= latest.endMs &&
    targetText.startsWith(text) && text.length >= 3 && unique(text, to) && latest.index === intermediate.at(-1));
  const target = strongTarget.filter(({speech, text}) => (!latest || speech.startMs >= latest.endMs) &&
    (!longJump || text.length >= T.forwardMinimumMatches))
    .sort((a, b) => b.speech.endMs - a.speech.endMs || b.text.length - a.text.length)[0] || ordered;
  if (target) return {action: 'advance', targetIndex: to, matches, target: target.speech};

  // A weak later opening is not enough to skip fresh intermediate speech.
  // Avoid replaying that cue if its evidence is already old at decision time.
  if (latest && Math.max(event.endMs, audioMs) - latest.endMs <= T.forwardCueFreshMs &&
    (!longJump || latest.index === intermediate[0] || latest.completed && latest.heard.length >= T.forwardMinimumMatches)) {
    return {action: 'intermediate', targetIndex: to, matches, cue: latest};
  }
  if (latest || longJump && !(candidate?.supportingIndex > from && candidate.supportingIndex < to &&
    candidate.pathConfirmed && candidate.speech?.words?.length)) {
    return {action: 'hold', targetIndex: to, matches};
  }
  return null;
}

module.exports = {reviewForwardCue};
