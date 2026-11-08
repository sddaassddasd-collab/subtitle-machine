// Provider timestamps count PCM actually delivered, not microphone wall time.
// Keep a bounded mapping to source time and mark every discontinuity explicitly.
class LiveAudioTimeline {
  constructor(sourceId) {this.sourceId = sourceId; this.providerMs = 0; this.ranges = []; this.droppedMs = 0;}
  drop(durationMs) {this.droppedMs += durationMs;}
  accept(packet, providerMs) {
    const start = packet.sourceStartMs, end = packet.sourceEndMs;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      (this.sourceId && packet.sourceId !== this.sourceId) ||
      (Number.isFinite(this.sourceEndMs) && start < this.sourceEndMs - 1)) return null;
    const previousEnd = this.sourceEndMs;
    const gapMs = Math.max(this.droppedMs, Number.isFinite(previousEnd) ? start - previousEnd : 0,
      Number(packet.droppedInputMs) || 0);
    const fromMs = providerMs, toMs = providerMs + packet.durationMs;
    const range = {providerStartMs: fromMs, providerEndMs: toMs, sourceStartMs: start, sourceEndMs: end};
    const previous = this.ranges.at(-1);
    if (previous && gapMs < 2 && Math.abs(previous.sourceEndMs - start) < 2) {
      previous.providerEndMs = toMs; previous.sourceEndMs = end;
    } else {this.ranges.push(range); this.ranges = this.ranges.slice(-256);}
    this.sourceEndMs = end; this.providerMs = toMs; this.droppedMs = 0;
    return {gapMs, sourceId: this.sourceId, ...range};
  }
  sourceTime(providerMs) {
    // The later range owns an exact boundary after a gap.
    const range = [...this.ranges].reverse().find(r => providerMs >= r.providerStartMs && providerMs <= r.providerEndMs);
    if (!range) return null;
    return range.sourceStartMs + (providerMs - range.providerStartMs) *
      (range.sourceEndMs - range.sourceStartMs) / (range.providerEndMs - range.providerStartMs);
  }
}
// A provider's result can start before a gap and still contain new speech.
// Fence by the spoken range, not the utterance/container start. Deepgram word
// times are seconds; internal diagnostic words may already use milliseconds.
function transcriptAfterGap(text, timing, fenceMs) {
  const result = {text, ...timing};
  if (!(fenceMs > 0)) return result;
  const endMs = Number.isFinite(timing.endMs) ? timing.endMs : null;
  if (endMs !== null && endMs <= fenceMs) return null;
  if (Number.isFinite(timing.startMs) && timing.startMs >= fenceMs - 1) return result;
  const words = timing.words?.filter(word => {
    const end = word.endMs ?? word.end * 1000;
    return Number.isFinite(end) && end > fenceMs;
  });
  if (words?.length) {
    result.words = words;
    result.text = words.map(word => word.punctuated_word || word.punctuatedWord || word.word || '').join(' ')
      .replace(/([\p{Script=Han}，。！？、])\s+(?=[\p{Script=Han}，。！？、])/gu, '$1');
    result.startMs = Math.max(fenceMs, words[0].startMs ?? words[0].start * 1000);
  } else {
    // Providers without word timings must not become permanently muted merely
    // because their utterance start is missing or precedes a transport gap.
    result.startMs = Math.max(fenceMs, timing.startMs || 0);
  }
  return result;
}
module.exports = {LiveAudioTimeline, transcriptAfterGap};
