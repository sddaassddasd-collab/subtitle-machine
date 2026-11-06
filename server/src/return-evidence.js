const {normalizeText} = require('./follow-text');
const {alignedWords, wordSpeech} = require('./word-evidence');

// A later revision may extend a proved phrase, but cannot silently replace it.
// Provider word ranges let a phrase remain stable inside a growing ASR item.
function preservedSpeech(event, previous, tolerance = 750) {
  const startMs = previous.anchorStartMs ?? previous.startMs, endMs = previous.anchorEndMs ?? previous.endMs;
  if (event.itemId !== previous.itemId || event.endMs < endMs - tolerance) return null;
  const words = alignedWords(event);
  if (words.length) {
    for (let first = 0; first < words.length; first++) {
      if (Math.abs(words[first].startMs - startMs) > tolerance) continue;
      let text = '';
      for (let last = first; last < words.length; last++) {
        text += normalizeText(words[last].text);
        if (!previous.text.startsWith(text)) break;
        if (text === previous.text && Math.abs(words[last].endMs - endMs) <= tolerance)
          return wordSpeech(event, words[first].id, words[last].id);
      }
    }
    return null;
  }
  return Math.abs(event.startMs - previous.startMs) <= 200 && normalizeText(event.text).startsWith(previous.text)
    ? {...event, text: previous.rawText, startMs: previous.startMs, endMs: previous.endMs} : null;
}

function returnMatch(records, event, match, now, settings) {
  for (const [key, record] of records) {
    const span = record.itemId === event.itemId ? preservedSpeech(event, record, settings.wordTimestampToleranceMs) : null;
    if (now - record.seenAt > settings.scriptContextTtlMs || (record.itemId === event.itemId && !span)) records.delete(key);
    else if (span) {
      record.startMs = span.startMs; record.endMs = span.endMs;
      record.match = {...record.match, speech: span, startMs: span.startMs, endMs: span.endMs};
    }
  }
  let current;
  if (match) {
    const speech = match.speech || {...event, startMs: match.startMs ?? event.startMs, endMs: match.endMs ?? event.endMs};
    current = [...records.values()].find(r => r.index === match.index && r.itemId === event.itemId &&
      Math.abs(r.startMs - speech.startMs) <= settings.wordTimestampToleranceMs && normalizeText(speech.text) === r.text);
    const at = current?.at ?? now;
    const unchanged = current?.text === normalizeText(speech.text);
    const anchorStartMs = unchanged ? current.anchorStartMs : speech.startMs;
    const anchorEndMs = unchanged ? current.anchorEndMs : speech.endMs;
    if (current) for (const [key, record] of records) if (record === current) records.delete(key);
    current = {itemId: event.itemId, index: match.index, text: normalizeText(speech.text), rawText: speech.text,
      startMs: speech.startMs, endMs: speech.endMs, at, seenAt: now, match: {...match, stableAt: at}};
    current.anchorStartMs = anchorStartMs; current.anchorEndMs = anchorEndMs;
    records.set(JSON.stringify([event.itemId, match.index, speech.startMs, current.text]), current);
  }
  while (records.size > settings.maximumStableMatches) records.delete(records.keys().next().value);
  const settled = [...records.values()].filter(r => r.itemId === event.itemId && preservedSpeech(event, r) &&
    event.audioMs - r.endMs <= settings.maximumLagMs && now - r.at >= settings.stableMs &&
    r.match.offset >= r.match.length - 1 && r.match.confidence >= settings.returnConfidence &&
    r.match.evidence >= settings.returnCharacters && r.match.margin >= settings.returnMargin);
  const best = settled.sort((a, b) => b.endMs - a.endMs || b.index - a.index)[0];
  // A stable complete phrase can survive a new candidate for a later, unfinished
  // phrase. A changed/withdrawn prefix was already removed above.
  if (best && (!current || !event.isFinal)) return {...best.match, speech: preservedSpeech(event, best),
    startMs: best.startMs, endMs: best.endMs, retained: best !== current};
  // A preserved prefix is stability, not a second observation or a completed
  // sentence. Only the independent ordered-path gate may use it for return.
  const prefix = !event.isFinal && current && alignedWords(event).length && [...records.values()].filter(r =>
    r.index === current.index && r.itemId === event.itemId && preservedSpeech(event, r) &&
    now - r.at >= settings.stableMs && event.audioMs - r.endMs <= settings.maximumLagMs &&
    !r.match.phonetic && r.match.confidence >= settings.weakReturnConfidence &&
    r.match.evidence >= 4 && r.match.matchedCharacters >= settings.weakReturnMatches && r.match.margin >= .1)
    .sort((a, b) => b.endMs - a.endMs)[0];
  if (prefix) {
    const strong = m => m.confidence >= settings.returnConfidence && m.evidence >= settings.returnCharacters &&
      m.margin >= settings.returnMargin;
    // A complete strong candidate may keep its earlier stable prefix's clock.
    // Do not replace that completed range with the shorter opening itself.
    if (strong(current.match) && strong(prefix.match) && current.match.length === prefix.match.length &&
      current.match.offset >= current.match.length - 1)
      return {...current.match, stableAt: prefix.at};
    return {...prefix.match, speech: preservedSpeech(event, prefix), startMs: prefix.startMs,
      endMs: prefix.endMs, retained: prefix !== current, stablePrefix: true};
  }
  return current?.match || match;
}

module.exports = {preservedSpeech, returnMatch};
