const {prepareScript, localSupportCandidates} = require('./auto-follow');
const {freshSpeech, wordWindows} = require('./word-evidence');
const {normalizeText} = require('./follow-text');

// Only raw provider text and word clocks enter the locator. Caption edits are
// display-only and never become independent script evidence.
function liveCandidates(script, window, speech) {
  const options = {ahead: window.to - window.origin, behind: window.origin - window.from, crossDirections: true};
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
    for (const c of liveCandidates(script, window, part)) {
      const prior = byIndex.get(c.index);
      if (!prior || c.confidence > prior.confidence) byIndex.set(c.index, c);
    }
    const candidates = [...byIndex.values()].sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
    return best ? {...best, margin: best.confidence - (candidates[1]?.confidence || 0)} : null;
  }).filter(Boolean);
  const admitted = pools.filter(c => c.evidence >= 4 && c.confidence >= .8 && c.margin >= .07);
  const best = (admitted.length ? admitted : pools).sort((a, b) =>
    b.speech.endMs - a.speech.endMs || b.confidence - a.confidence || b.evidence - a.evidence)[0];
  const accepted = admitted.includes(best);
  return {status: 'searching', reason: accepted ? 'background_script_candidate' : 'background_script_uncertain',
    ...(accepted ? {index: best.index} : {}), candidate: best || null, searchWindow: window,
    evidence: {startMs: best?.speech.startMs ?? speech.startMs, endMs: best?.speech.endMs ?? speech.endMs}, completed: false};
}

module.exports = {locateLiveScript, liveCandidates};
