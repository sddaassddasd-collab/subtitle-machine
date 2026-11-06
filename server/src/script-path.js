const {TEXT_SETTINGS: T} = require('./follow-settings');

// A bounded set of alternative forward paths. Repeating an interim or final
// never creates a second independent cue observation.
function observeScriptPath(tracker, script, currentIndex, candidates, event) {
  const lane = tracker.path ||= {hypotheses: [], lastMs: -1};
  if (event.endMs <= lane.lastMs) return null;
  lane.lastMs = event.endMs;
  const previous = lane.hypotheses.filter(h => event.endMs - h.endMs <= T.pathTtlMs && h.index >= currentIndex);
  const next = [];
  for (const candidate of candidates.slice(0, T.pathWidth * 2)) {
    if (candidate.index <= currentIndex || candidate.index > currentIndex + T.nearbyAhead ||
      candidate.confidence < T.minimumConfidence || candidate.evidence < T.pathMinimumEvidence ||
      candidate.offset < 2 || candidate.phonetic ||
      script.entries.slice(currentIndex, candidate.index + 1).some(e => e.source.music)) continue;
    let best = {index: candidate.index, score: candidate.confidence - T.pathSkipPenalty * (candidate.index - currentIndex - 1),
      steps: 1, endMs: event.endMs, startMs: event.startMs, itemId: event.itemId, heard: candidate.heard};
    for (const h of previous) {
      const advance = candidate.index - h.index;
      // Same-item growth must retain its earlier evidence. New items must not
      // overlap older audio; otherwise finals/revisions could fabricate a path.
      const fresh = event.itemId === h.itemId ? candidate.heard.startsWith(h.heard) && candidate.heard !== h.heard
        : event.startMs >= h.endMs;
      if (advance < 0 || advance > T.pathMaximumStep || !fresh) continue;
      const score = candidate.confidence + T.pathRetention * h.score - T.pathSkipPenalty * Math.max(0, advance - 1);
      if (score > best.score) best = {...best, score, steps: h.steps + Number(advance > 0)};
    }
    next.push(best);
  }
  // A weak observation does not erase earlier alternatives, nor extend TTL.
  const byIndex = new Map();
  for (const h of [...next, ...previous]) {
    if (!byIndex.has(h.index) || h.score > byIndex.get(h.index).score) byIndex.set(h.index, h);
  }
  lane.hypotheses = [...byIndex.values()].sort((a, b) => b.score - a.score).slice(0, T.pathWidth);
  const best = lane.hypotheses[0], runner = lane.hypotheses[1];
  if (!best || best.endMs !== event.endMs || best.steps < T.pathMinimumSteps ||
    (runner && best.score - runner.score < T.minimumMargin)) return null;
  const candidate = candidates.find(c => c.index === best.index);
  return candidate ? {...candidate, pathConfirmed: true, pathSteps: best.steps} : null;
}

function isCurrentSuffix(script, currentIndex, text, best, currentCandidate) {
  const current = script.entries[currentIndex]?.text;
  return Boolean(best && best.index > currentIndex + 1 && current && text.length >= 3 &&
    current !== text && (current.endsWith(text) || (text.length >= 6 && current.length > text.length &&
      currentCandidate && currentCandidate.offset === currentCandidate.length && currentCandidate.confidence >= T.strongConfidence)));
}

// Weaker evidence has its own lane: it must not out-rank or erase the normal
// path. Only a recent, literal text anchor permits this three-cue recovery.
function observeWeakScriptPath(tracker, script, currentIndex, candidates, event) {
  const anchor = tracker.textAnchor || tracker.lastLocated;
  const anchored = anchor?.literal && anchor.confidence >= T.strongConfidence &&
    currentIndex >= anchor.index && currentIndex <= anchor.index + 1 &&
    event.startMs >= anchor.atMs && event.endMs - anchor.atMs <= T.weakAnchorTtlMs;
  if (!anchored) { tracker.weakPath = {hypotheses: [], lastMs: -1}; return null; }
  const lane = tracker.weakPath ||= {hypotheses: [], lastMs: -1};
  if (event.endMs <= lane.lastMs) return null;
  lane.lastMs = event.endMs;
  const previous = lane.hypotheses.filter(h => h.index > currentIndex && event.endMs - h.endMs <= T.pathTtlMs);
  const next = [];
  for (const c of candidates.slice(0, T.pathWidth * 2)) {
    const matches = c.matchedCharacters ?? Math.floor(c.confidence * c.evidence);
    if (c.index <= currentIndex || c.index > currentIndex + T.weakPathAhead || c.phonetic || c.context ||
      (event.text && !event.text.endsWith(c.heard)) ||
      c.confidence < T.weakPathConfidence || c.evidence < T.weakPathEvidence || matches < T.weakPathMatches || c.offset < 2 ||
      script.entries.slice(currentIndex, c.index + 1).some(e => e.source.music || e.source.type === 'direction')) continue;
    let best = {index: c.index, score: c.confidence - T.pathSkipPenalty * (c.index - currentIndex - 1),
      steps: 1, weak: c.confidence < T.minimumConfidence, itemId: event.itemId, endMs: event.endMs};
    for (const h of previous) {
      const advance = c.index - h.index;
      if (event.itemId === h.itemId || event.startMs < h.endMs || advance < 1 || advance > T.pathMaximumStep) continue;
      const score = c.confidence + T.pathRetention * h.score - T.pathSkipPenalty * (advance - 1);
      if (score > best.score) best = {...best, score, steps: h.steps + 1, weak: best.weak || h.weak};
    }
    next.push(best);
  }
  const byIndex = new Map();
  for (const h of [...next, ...previous]) if (!byIndex.has(h.index) || h.score > byIndex.get(h.index).score) byIndex.set(h.index, h);
  lane.hypotheses = [...byIndex.values()].sort((a, b) => b.score - a.score).slice(0, T.pathWidth);
  const best = lane.hypotheses[0], runner = lane.hypotheses[1];
  if (!best?.weak || best.steps < T.weakPathMinimumSteps || best.endMs !== event.endMs ||
    (runner && best.score - runner.score < T.minimumMargin)) return null;
  const c = candidates.find(c => c.index === best.index);
  return c ? {...c, weakPath: true, pathConfirmed: true, pathSteps: best.steps} : null;
}
module.exports = {observeScriptPath, observeWeakScriptPath, isCurrentSuffix, ...require('./word-path')};
