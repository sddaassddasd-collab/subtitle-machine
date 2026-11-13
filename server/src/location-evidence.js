const {normalizeText} = require('./follow-text');
const {alignedWords, suffixSpeech} = require('./word-evidence');

// Record actual containing provider words. A match using historical text is
// explicitly scoped to the current revision, not assigned invented word clocks.
function locationEvidence(event, candidate) {
  const heard = candidate?.heard || candidate?.speech?.text || '';
  const speech = candidate?.speech || suffixSpeech(event, heard) || event;
  const words = alignedWords(speech);
  const includesHistory = Boolean(heard && !normalizeText(event.text).includes(normalizeText(heard)));
  return {startMs: words[0]?.startMs ?? speech.startMs, endMs: words.at(-1)?.endMs ?? speech.endMs,
    kind: words.length ? 'provider_word_range' : 'transcript_range',
    scope: includesHistory ? 'current_revision_of_context_match' : 'current_revision',
    firstWordId: words[0]?.id ?? null, lastWordId: words.at(-1)?.id ?? null,
    text: String(speech.text || '').slice(-120), matchedText: String(heard).slice(-120), includesHistory};
}
module.exports = {locationEvidence};
