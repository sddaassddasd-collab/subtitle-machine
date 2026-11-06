// A display handoff is independent of script recognition. Once a line already
// on screen is located, keep its spoken wording until an actual cue change.
class CaptionPresentation {
  constructor() { this.published = null; this.held = null; }
  clear() { this.published = null; this.held = null; }
  publish(entries) {
    const latest = entries.at(-1);
    if (latest?.text) this.published = {...latest, translations: {...latest.translations}};
  }
  reacquired(index, entries, audioStartMs, audioEndMs, cellId) {
    const latest = entries.at(-1), previous = this.published;
    if (!latest || !previous || latest.id !== previous.id || !Number.isFinite(previous.endMs) ||
      audioStartMs >= previous.endMs || audioEndMs <= previous.startMs) { this.clear(); return false; }
    this.held = {index, cellId, entry: {...latest, translations: {...latest.translations}}};
    return true;
  }
  holding(index, cellId) { return this.held?.index === index && this.held.cellId === cellId; }
  advance(index, cellId) { if (this.held && !this.holding(index, cellId)) this.clear(); }
}
module.exports = {CaptionPresentation, CAPTION_PRESENTATION_SETTINGS: Object.freeze({version: 1, transitionMs: 120,
  automaticLiveEntries: 1, waitForCueChange: true, preserveManualOverride: true})};
