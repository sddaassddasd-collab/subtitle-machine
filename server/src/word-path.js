const {TEXT_SETTINGS: T} = require('./follow-settings');
const {alignedWords} = require('./word-evidence');
const {normalizeText} = require('./follow-text');

function retainedWitness(witness, event, words) {
  if (witness.itemId !== event.itemId || (witness.inputId && witness.inputId === event.revisionId)) return witness;
  const revised = words.filter(w => w.startMs >= witness.startMs - T.wordRevisionToleranceMs &&
    w.endMs <= witness.endMs + T.wordRevisionToleranceMs);
  if (!revised.length || normalizeText(revised.map(w => w.text).join('')) !== witness.text) return null;
  return {...witness, startMs: Math.min(witness.startMs, revised[0].startMs),
    endMs: Math.max(witness.endMs, revised.at(-1).endMs), validatedInputId: event.revisionId ?? null};
}

// A word clock, not an ASR item ID, defines independent speech. Revisions may
// replace a hypothesis but cannot extend a path using overlapping word ranges.
function observeWordPath(tracker, script, currentIndex, candidates, event) {
  const anchor = tracker.textAnchor;
  if (!anchor || currentIndex < anchor.index || currentIndex > anchor.index + 1 ||
    event.endMs - anchor.atMs > T.weakAnchorTtlMs) return null;
  const lane = tracker.wordPath ||= {hypotheses: []};
  const words = alignedWords(event);
  let paths = lane.hypotheses.filter(h => h.index >= currentIndex && event.endMs - h.endMs <= T.pathTtlMs)
    .flatMap(h => {
      const witnesses = h.witnesses.map(w => retainedWitness(w, event, words));
      if (witnesses.some((w, i) => !w || (i && w.startMs < witnesses[i - 1].endMs))) return [];
      return [{...h, witnesses, endMs: witnesses.at(-1).endMs}];
    });
  for (const c of candidates.sort((a, b) => a.speech.endMs - b.speech.endMs || b.rank - a.rank)) {
    const speech = c.speech;
    if (c.index < currentIndex || c.index > currentIndex + T.weakPathAhead || speech.startMs < anchor.atMs ||
      c.confidence < T.weakPathConfidence || c.matchedCharacters < Math.min(T.shortAnchorEvidence, script.entries[c.index].length) ||
      script.entries.slice(currentIndex, c.index + 1).some(e => e.source.music || e.source.type === 'direction')) continue;
    const witness = {index: c.index, itemId: event.itemId, text: normalizeText(speech.text), inputId: event.revisionId ?? null, firstWordId: speech.firstWordId,
      lastWordId: speech.lastWordId, startMs: speech.startMs, endMs: speech.endMs, confidence: c.confidence};
    let best = {index: c.index, score: c.rank, steps: 1, endMs: speech.endMs,
      strong: c.confidence >= T.strongConfidence && c.matchedCharacters >= T.shortAnchorEvidence, witnesses: [witness], candidate: c};
    for (const h of paths) {
      const step = c.index - h.index;
      if (step < 1 || step > T.pathMaximumStep || speech.startMs < h.endMs ||
        speech.endMs - h.endMs > T.pathTtlMs) continue;
      const score = c.rank + T.pathRetention * h.score - T.pathSkipPenalty * (step - 1);
      if (score > best.score) best = {...best, score, steps: h.steps + 1, strong: best.strong || h.strong,
        witnesses: [...h.witnesses, witness].slice(-T.weakPathMinimumSteps)};
    }
    const byIndex = new Map();
    for (const h of [best, ...paths]) if (!byIndex.has(h.index) || h.score > byIndex.get(h.index).score ||
      (h.score === byIndex.get(h.index).score && h.endMs < byIndex.get(h.index).endMs)) byIndex.set(h.index, h);
    paths = [...byIndex.values()].sort((a, b) => b.score - a.score).slice(0, T.pathWidth);
  }
  lane.hypotheses = paths;
  const [best, runner] = paths.filter(h => h.index > currentIndex);
  if (!best || best.endMs > event.endMs || !best.strong || best.steps < T.wordPathSteps || best.index < (event.minimumIndex ?? -1) ||
    (runner && best.score - runner.score < T.minimumMargin)) return null;
  return {...best.candidate, wordEvidence: true, pathSteps: best.steps, wordWitnesses: best.witnesses};
}
module.exports = {observeWordPath};
