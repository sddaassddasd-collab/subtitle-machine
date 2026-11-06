// A display handoff is independent of script recognition. Once a line already
// on screen is located, keep its spoken wording until an actual cue change.
const {normalizeText} = require('./follow-text');
const {alignedWords, freshSpeech, wordSpeech} = require('./word-evidence');
const CAPTION_PRESENTATION_SETTINGS = Object.freeze({version: 2, transitionMs: 120,
  automaticLiveEntries: 1, waitForCueChange: true, preserveManualOverride: true,
  minimumCharacters: 4, immediateCharacters: 8, stableMs: 250, revisionToleranceMs: 200});
class CaptionPresentation {
  constructor() { this.clear(); }
  clear() { this.published = null; this.held = null; this.draft = null; }
  publish(entries, now = Date.now()) {
    const latest = entries.at(-1);
    if (latest?.text) {
      const text = normalizeText(latest.text), previous = this.draft;
      const continuous = previous?.id === latest.id && previous.prefix.length >= CAPTION_PRESENTATION_SETTINGS.minimumCharacters &&
        text.startsWith(previous.prefix);
      this.draft = {id: latest.id, prefix: text.slice(0, CAPTION_PRESENTATION_SETTINGS.minimumCharacters),
        at: continuous ? previous.at : now};
      const ready = latest.isFinal || text.length >= CAPTION_PRESENTATION_SETTINGS.immediateCharacters ||
        (text.length >= CAPTION_PRESENTATION_SETTINGS.minimumCharacters && now - this.draft.at >= CAPTION_PRESENTATION_SETTINGS.stableMs);
      if (ready || (latest.id === this.published?.id && text === normalizeText(this.published.text)))
        this.published = {...latest, translations: {...latest.translations}};
    }
    return this.published ? [this.published] : [];
  }
  reacquired(index, entries, audioStartMs, audioEndMs, cellId) {
    const latest = entries.at(-1), previous = this.published;
    if (!latest || !previous || latest.id !== previous.id || !Number.isFinite(previous.endMs) ||
      audioStartMs >= previous.endMs || audioEndMs <= previous.startMs) { this.clear(); return false; }
    this.held = {index, cellId, entry: {...latest, translations: {...latest.translations}}};
    return true;
  }
  revise(event) {
    const entry = this.held?.entry;
    if (!entry || event.itemId !== entry.id) return false;
    let speech;
    if (event.endMs <= entry.endMs + CAPTION_PRESENTATION_SETTINGS.revisionToleranceMs) speech = freshSpeech(event, entry.startMs);
    else {
      const words = alignedWords(event).filter(w => w.startMs >= entry.startMs &&
        w.endMs <= entry.endMs + CAPTION_PRESENTATION_SETTINGS.revisionToleranceMs);
      if (words.length) speech = wordSpeech(event, words[0].id, words.at(-1).id);
    }
    if (!speech?.text || speech.endMs < entry.endMs - CAPTION_PRESENTATION_SETTINGS.revisionToleranceMs) return false;
    // Keep the original audio fence even when the same ASR item grows into the next cue.
    this.held.entry = {...entry, text: speech.text, isFinal: event.isFinal === true,
      translations: speech.text === entry.text ? entry.translations : {}};
    return true;
  }
  holding(index, cellId) { return this.held?.index === index && this.held.cellId === cellId; }
  advance(index, cellId) { if (this.held && !this.holding(index, cellId)) this.clear(); }
}
module.exports = {CaptionPresentation, CAPTION_PRESENTATION_SETTINGS};
