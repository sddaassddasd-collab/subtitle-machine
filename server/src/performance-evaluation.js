const {normalizeText, createTracker, followTranscript} = require('./auto-follow');

function editDistance(a, b) {
  let previous = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++) row.push(Math.min(previous[j + 1] + 1, row[j] + 1,
      previous[j] + Number(a[i] !== b[j])));
    previous = row;
  }
  return previous[b.length];
}

// Compare recognizer outputs from the SAME audio against independently
// annotated speech. This never sends audio or calls a paid provider.
function evaluatePerformance({lines, spokenText, cues, runs}) {
  if (!Array.isArray(lines) || !Array.isArray(cues) || !cues.length || !Array.isArray(runs) || !runs.length)
    throw new Error('Expected lines, annotated cues and recognizer runs');
  if (typeof spokenText !== 'string' || !normalizeText(spokenText)) throw new Error('Expected independently transcribed spokenText');
  let lastEnd = -1;
  for (const cue of cues) {
    if (!Number.isInteger(cue.index) || !lines[cue.index] || !Number.isFinite(cue.startMs) ||
      !Number.isFinite(cue.endMs) || cue.startMs < lastEnd || cue.endMs <= cue.startMs)
      throw new Error('Cue annotations must be ordered, nonoverlapping and use valid script indices');
    lastEnd = cue.endMs;
  }
  return {schemaVersion: 1, mode: 'annotated-text-replay', results: runs.map(run => {
    if (run.mode === 'offline') {
      if (!Array.isArray(run.segments) || run.segments.some(s => typeof s.text !== 'string'))
        throw new Error('Offline runs require text segments');
      const finalText = run.segments.map(s => s.text).join('');
      const expected = Array.from(normalizeText(spokenText)), actual = Array.from(normalizeText(finalText));
      const errors = editDistance(expected, actual);
      return {name: String(run.name || run.model || 'unnamed'), mode: 'offline', finalText,
        normalizedCharacterCount: expected.length, characterErrors: errors, characterErrorRate: errors / expected.length,
        inferenceSeconds: run.inferenceSeconds ?? null,
        note: 'Whole-file inference cannot establish streaming cue accuracy or availability latency.'};
    }
    if (!Array.isArray(run.revisions)) throw new Error('Expected revisions for each recognizer');
    let current = cues[0].index, lastReceived = -1;
    const tracker = createTracker(), finals = new Map(), located = new Map(), decisions = [], reasons = {};
    const timings = [];
    for (const [i, revision] of run.revisions.entries()) {
      if (!Number.isFinite(revision.receivedMs) || revision.receivedMs < lastReceived ||
        !Number.isFinite(revision.startMs) || !Number.isFinite(revision.endMs) ||
        revision.startMs < 0 || revision.endMs < revision.startMs || revision.receivedMs < revision.endMs ||
        typeof revision.text !== 'string' || typeof revision.itemId !== 'string')
        throw new Error('Revisions require ordered receivedMs, valid audio times, text and itemId');
      lastReceived = revision.receivedMs;
      if (revision.isFinal) finals.set(revision.itemId, revision);
      const start = performance.now();
      const result = followTranscript(tracker, lines, current, {...revision, streamId: 'evaluation', order: revision.order ?? i});
      timings.push(performance.now() - start);
      reasons[result.reason || result.status] = (reasons[result.reason || result.status] || 0) + 1;
      if (Number.isInteger(result.index)) {
        if (!located.has(result.index)) located.set(result.index, revision.receivedMs);
        if (result.index !== current) decisions.push({fromIndex: current, index: result.index, receivedMs: revision.receivedMs});
        current = result.index;
      }
    }
    const expected = Array.from(normalizeText(spokenText));
    const actual = Array.from(normalizeText([...finals.values()].sort((a, b) => a.startMs - b.startMs).map(r => r.text).join('')));
    const distances = editDistance(expected, actual);
    const rows = cues.map(cue => ({...cue, firstLocatedMs: located.get(cue.index) ?? null,
      firstLocationDelayMs: located.has(cue.index) ? located.get(cue.index) - cue.startMs : null,
      locatedDuringCue: located.has(cue.index) && located.get(cue.index) >= cue.startMs && located.get(cue.index) < cue.endMs}));
    timings.sort((a, b) => a - b);
    return {name: String(run.name || 'unnamed'), finalText: [...finals.values()].sort((a, b) => a.startMs - b.startMs).map(r => r.text).join(''),
      normalizedCharacterCount: expected.length, characterErrors: distances, characterErrorRate: distances / expected.length,
      finalizedItems: finals.size, unfinalizedItems: new Set(run.revisions.filter(r => !finals.has(r.itemId)).map(r => r.itemId)).size,
      locatedCues: rows.filter(r => r.firstLocatedMs !== null).length, locatedDuringCue: rows.filter(r => r.locatedDuringCue).length,
      missedCues: rows.filter(r => r.firstLocatedMs === null).length,
      backwards: decisions.filter(d => d.index < d.fromIndex).length,
      alignmentP95Ms: timings[Math.max(0, Math.ceil(timings.length * .95) - 1)] ?? null, reasons, decisions, rows};
  }), note: 'Text-only replay; first location includes confirmation of the starting cue. No onset, PCM or display-render latency evaluated. CER requires nonoverlapping final utterances.'};
}
module.exports = {evaluatePerformance};
