const {SEMANTIC_SETTINGS: S} = require('./follow-settings');
const {normalizeText} = require('./follow-text');
const {preservedSpeech} = require('./return-evidence');
const {align} = require('./auto-follow');

// This is corroboration of ONE observation, never independent audio evidence.
// Be conservative about explicit negation and subject changes on this shortcut;
// other paraphrases can still use the independent-support path.
function meaningMarkers(text) {
  const normalized = normalizeText(text).replace(/沒有/g, '沒');
  const english = String(text || '').normalize('NFKC').toLowerCase().replace(/’/g, "'");
  return JSON.stringify([
    normalized.match(/不|沒|無|未|別|勿|莫/g) || [],
    normalized.match(/我們|你們|他們|她們|我|你|他|她/g) || [],
    (english.match(/\b(?:not|no|never|cannot)\b|n't/g) || []).map(() => 'negative'),
    english.match(/\b(?:i|we|you|he|she|they)\b/g) || [],
  ]);
}

function corroborateLongMatch(state, match) {
  const h = state.handlers, context = h.corroborationContext?.();
  if (!context || !match.speech || match.tier !== 'high' || !h.textCandidates ||
    match.index < context.displayIndex || match.index > context.displayIndex + S.jointMaximumStep ||
    (match.index === context.displayIndex && !context.predicted) || !context.allowed(match.index)) return null;
  const anchor = context.anchor, original = match.speech;
  if (!anchor?.literal || anchor.confidence < S.minimumConfidence ||
    context.displayIndex < anchor.index || context.displayIndex > anchor.index + 1 ||
    original.startMs < anchor.atMs || original.endMs - anchor.atMs > S.jointAnchorTtlMs) return null;
  const item = state.memory.items.get(original.itemId), latest = item?.revisions.at(-1);
  const record = {itemId: original.itemId, text: normalizeText(original.text), rawText: original.text,
    startMs: original.startMs, endMs: original.endMs};
  const speech = latest && preservedSpeech(latest, record, S.wordTimestampToleranceMs);
  if (!speech || context.audioMs - speech.endMs > S.maximumResultAgeMs) return null;
  // Receiving the model answer is not a new ASR observation. A final or two
  // actual revisions preserving this word range must establish its stability.
  const stable = latest.isFinal || item.revisions.some(r => r.inputId !== latest.inputId &&
    latest.receivedAt - r.receivedAt >= S.interimStableMs && preservedSpeech(r, record, S.wordTimestampToleranceMs));
  if (!stable || normalizeText(speech.text).length < S.jointCharacters ||
    meaningMarkers(speech.text) !== meaningMarkers(match.text)) return null;
  const literal = h.textCandidates(speech).filter(c => c.index === match.index && !c.phonetic &&
    normalizeText(c.speech?.text || c.heard || '') === normalizeText(speech.text) &&
    c.confidence >= S.jointConfidence && c.evidence >= S.jointCharacters &&
    c.matchedCharacters >= S.jointLiteralMatches && c.matchedCharacters / c.evidence >= S.jointCoverage &&
    c.offset / c.length >= S.jointProgress && c.supportMargin >= S.textMargin)
    .sort((a, b) => b.confidence - a.confidence)[0];
  return literal ? {speech, literal} : null;
}

// A displayed short opening already fixes the position. Verify that SAME cue
// with a stable timed span and substantial literal coverage; never use this
// shortcut to relocate, confirm a negated line, or invent a sentence ending.
function corroborateCurrentMatch(state, match) {
  const h = state.handlers, context = h.corroborationContext?.(), original = match.speech;
  if (!context || !original || match.tier !== 'high' || !Number.isFinite(match.matchConfidence) || match.matchConfidence < S.currentConfidence ||
    !h.textCandidates || context.predictionSource !== 'opening' || !context.predicted ||
    match.index !== context.displayIndex || !context.allowed(match.index)) return null;
  const anchor = context.anchor;
  if (!anchor?.literal || anchor.confidence < S.minimumConfidence ||
    anchor.index !== match.index - 1 || original.startMs < anchor.atMs ||
    original.endMs - anchor.atMs > S.jointAnchorTtlMs) return null;
  const item = state.memory.items.get(original.itemId), latest = item?.revisions.at(-1);
  const record = {itemId: original.itemId, text: normalizeText(original.text), rawText: original.text,
    startMs: original.startMs, endMs: original.endMs};
  const speech = latest && preservedSpeech(latest, record, S.wordTimestampToleranceMs);
  if (!speech || context.audioMs - speech.endMs > S.maximumResultAgeMs ||
    meaningMarkers(speech.text) !== meaningMarkers(match.text)) return null;
  const stable = latest.isFinal || item.revisions.some(r => r.inputId !== latest.inputId &&
    latest.receivedAt - r.receivedAt >= S.interimStableMs && preservedSpeech(r, record, S.wordTimestampToleranceMs));
  if (!stable) return null;
  const literal = h.textCandidates(speech).find(c => c.index === match.index && !c.phonetic &&
    normalizeText(c.speech?.text || c.heard || '') === normalizeText(speech.text) &&
    c.confidence >= S.currentTextConfidence && c.matchedCharacters >= S.currentLiteralMatches &&
    c.matchedCharacters / c.length >= S.currentCoverage && c.offset / c.length >= S.currentCoverage &&
    c.supportMargin >= S.textMargin);
  return literal ? {speech, literal} : null;
}

// A short paraphrase can verify only the already prepared immediate next cue.
// Require a stable real word span, strong semantic agreement and a literal
// part of THIS cue (not characters borrowed from the preceding ASR sentence).
function corroborateSequentialMatch(state, match) {
  const h = state.handlers, context = h.corroborationContext?.(), original = match.speech;
  const length = normalizeText(match.text).length, anchor = context?.anchor;
  if (!original || match.tier !== 'high' || !Number.isFinite(match.matchConfidence) || match.matchConfidence < S.sequentialConfidence ||
    !h.textCandidates || !context || context.predicted || match.index !== context.displayIndex + 1 ||
    context.preparedIndex !== match.index || !context.allowed(match.index) ||
    length < S.sequentialMinimumCharacters || length > S.sequentialMaximumCharacters ||
    !anchor?.literal || anchor.index !== context.displayIndex || anchor.confidence < S.minimumConfidence ||
    original.startMs < anchor.atMs || original.endMs - anchor.atMs > S.jointAnchorTtlMs) return null;
  const item = state.memory.items.get(original.itemId), latest = item?.revisions.at(-1);
  const record = {itemId: original.itemId, text: normalizeText(original.text), rawText: original.text,
    startMs: original.startMs, endMs: original.endMs};
  const speech = latest && preservedSpeech(latest, record, S.wordTimestampToleranceMs);
  if (!speech || context.audioMs - speech.endMs > S.maximumResultAgeMs ||
    normalizeText(speech.text).length < S.sequentialMinimumCharacters || normalizeText(speech.text).length > length + 2 ||
    meaningMarkers(speech.text) !== meaningMarkers(match.text)) return null;
  const stable = latest.isFinal || item.revisions.some(r => r.inputId !== latest.inputId &&
    latest.receivedAt - r.receivedAt >= S.interimStableMs && preservedSpeech(r, record, S.wordTimestampToleranceMs));
  if (!stable) return null;
  const own = align(speech.text, [{text: match.text}], 0, 0, {local: true})[0];
  const runner = h.textCandidates(speech).filter(c => c.index !== match.index).sort((a, b) => b.confidence - a.confidence)[0];
  const margin = own?.confidence - (runner?.confidence || 0);
  return own && own.matchedCharacters >= S.sequentialLiteralMatches && own.matchedCharacters / length >= S.sequentialCoverage &&
    own.offset / length >= S.currentCoverage && margin >= S.textMargin
    ? {speech, literal: {...own, supportMargin: margin}} : null;
}

module.exports = {corroborateLongMatch, corroborateCurrentMatch, corroborateSequentialMatch};
