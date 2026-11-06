const {SEMANTIC_SETTINGS: S} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {timedWords, freshSpeech} = require('./word-evidence');

// Bounded hypotheses, not a concatenated transcript. Superseded ASR words are
// labelled alternatives; their audio still belongs to the same observation.
class SemanticTranscript {
  constructor() { this.items = new Map(); this.sequence = 0; }
  remember(event, now) {
    if (!event.itemId || !normalizeText(event.text) || !Number.isFinite(event.startMs) ||
      !Number.isFinite(event.endMs) || event.endMs <= event.startMs) return null;
    for (const [id, item] of this.items) if (event.startMs - item.endMs > S.historyMs) this.items.delete(id);
    let item = this.items.get(event.itemId);
    if (!item) {
      item = {revisions: [], requests: 0, endMs: event.endMs};
      this.items.set(event.itemId, item);
    }
    const last = item.revisions.at(-1);
    if (last?.isFinal || (last?.text === event.text && last.isFinal === Boolean(event.isFinal))) return null;
    const words = timedWords(event, S.maximumWords);
    const sequence = ++this.sequence;
    const revision = {inputId: event.revisionId || `${event.itemId}:${sequence}`, itemId: event.itemId,
      text: String(event.text).slice(-S.heardCharacters), startMs: event.startMs, endMs: event.endMs,
      isFinal: event.isFinal === true, confidence: Number.isFinite(event.confidence) ? event.confidence : null,
      receivedAt: Number.isFinite(event.receivedAt) ? event.receivedAt : now, words};
    item.revisions.push(revision);
    if (item.revisions.length > S.revisionsPerItem) item.revisions.shift();
    item.endMs = Math.max(item.endMs, event.endMs);
    while (this.items.size > S.historyItems) this.items.delete(this.items.keys().next().value);
    return revision;
  }
  input(revision) {
    const item = this.items.get(revision.itemId);
    const alternatives = [...new Map(item.revisions.filter(r => r.text !== revision.text).map(r => [r.text, r])).values()]
      .slice(-S.alternatives);
    const previous = [...this.items.values()].map(i => i.revisions.at(-1))
      .filter(r => r.itemId !== revision.itemId && r.endMs <= revision.startMs &&
        revision.startMs - r.endMs <= S.historyMs).slice(-S.previousItems)
      .map(r => ({inputId: r.inputId, text: r.text.slice(-S.previousCharacters), startMs: r.startMs,
        endMs: r.endMs, isFinal: r.isFinal}));
    return {heard: revision.text, latest: revision, alternatives, previous,
      // Include superseded longer hypotheses in the independence fence. A
      // shortened final cannot make that earlier audio count a second time.
      evidenceEndMs: item.endMs};
  }
  requestReason(revision, minimumCharacters = S.minimumTextLength) {
    const item = this.items.get(revision.itemId), revisions = item.revisions;
    if (Math.max(...revisions.map(r => normalizeText(r.text).length)) < minimumCharacters) return 'insufficient_text';
    if (item.requests >= S.requestsPerItem) return 'item_request_limit';
    if (!revision.isFinal) {
      const earlier = revisions.find(r => revision.receivedAt - r.receivedAt >= S.interimStableMs &&
        commonPrefix(normalizeText(r.text), normalizeText(revision.text)) >= minimumCharacters);
      if (!earlier) return 'unstable_interim';
    }
    if (item.requested && (revision.endMs <= item.requested.endMs ||
      normalizeText(revision.text).length - commonPrefix(normalizeText(item.requested.text), normalizeText(revision.text)) < S.newTextCharacters))
      return 'no_new_request_evidence';
    return null;
  }
  requested(revision) {
    const item = this.items.get(revision.itemId);
    item.requests++; item.requested = {text: revision.text, endMs: item.endMs};
  }
  latest() { return [...this.items.values()].map(item => item.revisions.at(-1)); }
}
function commonPrefix(a, b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; }

module.exports = {SemanticTranscript, freshSpeech};
