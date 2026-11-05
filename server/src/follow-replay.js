const engine = require('./auto-follow');

// Text-only counterfactual. Recorded automatic cue changes are outputs of the
// old engine, not independent inputs, and must never be fed back as truth.
function replayFollow(report, implementation = engine) {
  let tracker = implementation.createTracker(), lines = [], currentIndex = 0;
  const reasons = {}, decisions = [], verified = new Set();
  let revisions = 0, maximumAlignmentMs = 0;
  const alignmentTimes = [];
  for (const event of report.events) {
    if (event.type === 'context') {
      lines = event.lines; tracker = implementation.createTracker();
      currentIndex = report.events.find(e => e.type === 'cue_enter' && e.contextId === event.contextId)?.index || 0;
    }
    if (event.type === 'cue_enter' && event.source === 'manual') {
      currentIndex = event.index;
      tracker = implementation.createTracker({ignoreBeforeMs: event.audioMs ?? -1});
    }
    if (event.type !== 'transcript_revision' || !lines.length) continue;
    const started = performance.now();
    const result = implementation.followTranscript(tracker, lines, currentIndex, {
      streamId: event.providerStreamId, itemId: event.itemId, order: event.order,
      text: event.text, startMs: event.audioStartMs, endMs: event.audioEndMs, isFinal: event.isFinal,
    });
    const alignmentMs = performance.now() - started;
    maximumAlignmentMs = Math.max(maximumAlignmentMs, alignmentMs);
    alignmentTimes.push(alignmentMs);
    revisions++;
    const reason = result.reason || result.status;
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (Number.isInteger(result.index)) {
      verified.add(result.index);
      if (result.index !== currentIndex) decisions.push({at: event.at, audioEndMs: event.audioEndMs,
        fromIndex: currentIndex, index: result.index, reason});
      currentIndex = result.index;
    }
  }
  alignmentTimes.sort((a, b) => a - b);
  const percentile = p => alignmentTimes[Math.max(0, Math.ceil(alignmentTimes.length * p) - 1)] ?? null;
  return {schemaVersion: 1, mode: 'text-only', groundTruthAvailable: false, revisions, maximumAlignmentMs,
    alignmentMs: {median: percentile(.5), p95: percentile(.95), maximum: maximumAlignmentMs},
    finalIndex: currentIndex, verifiedIndices: [...verified].sort((a, b) => a - b), reasons, decisions,
    note: 'No live PCM, onset decisions or display acknowledgements replayed. Counts are observations, not accuracy.'};
}
module.exports = {replayFollow};
