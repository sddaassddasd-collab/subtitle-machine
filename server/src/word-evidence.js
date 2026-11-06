const {normalizeText} = require('./follow-text');

// IDs are scoped to one ASR revision. Actual provider clocks stay local; a
// model can select word IDs but cannot supply or change audio timestamps.
function timedWords(event, maximum = 128) {
  if (!Array.isArray(event.words)) return [];
  const offset = Math.max(0, event.words.length - maximum), words = [];
  for (const [i, w] of event.words.slice(offset).entries()) {
    if (!w || typeof w !== 'object') return [];
    const startMs = Number.isFinite(w.startMs) ? w.startMs : w.start * 1000;
    const endMs = Number.isFinite(w.endMs) ? w.endMs : w.end * 1000;
    const text = String(w.text ?? w.word ?? '').slice(0, 80);
    if (!normalizeText(text)) continue;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
      startMs < event.startMs || endMs > event.endMs + 1 || (words.length && startMs < words.at(-1).endMs)) return [];
    words.push({id: Number.isInteger(w.id) ? w.id : offset + i, text, startMs, endMs,
      confidence: Number.isFinite(w.confidence) ? w.confidence : null});
  }
  return words;
}
function alignedWords(event) {
  const words = timedWords(event), text = normalizeText(event.text);
  // Long inputs are tail bounded. Retain only a suffix demonstrably present in
  // both the transcript and provider words. Disagreeing word text is not proof.
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i);
    if (text.endsWith(tail.map(w => normalizeText(w.text)).join(''))) return tail;
  }
  return [];
}
function wordSpeech(event, firstWordId, lastWordId) {
  if (!Number.isInteger(firstWordId) || !Number.isInteger(lastWordId) || firstWordId > lastWordId) return null;
  const words = alignedWords(event), from = words.findIndex(w => w.id === firstWordId), to = words.findIndex(w => w.id === lastWordId);
  if (from < 0 || to < from) return null;
  const selected = words.slice(from, to + 1);
  if (selected.some((w, i) => i && w.id !== selected[i - 1].id + 1)) return null;
  return {...event, text: selected.map(w => w.text).join(''), words: selected,
    startMs: selected[0].startMs, endMs: selected.at(-1).endMs, firstWordId, lastWordId};
}
function freshSpeech(event, afterMs) {
  if (event.endMs <= afterMs) return null;
  if (event.startMs >= afterMs) return event;
  const words = alignedWords(event).filter(w => w.startMs >= afterMs);
  return words.length ? wordSpeech(event, words[0].id, words.at(-1).id) : null;
}
function wordWindows(event, {maximumWords = 24, windowWords = 12, minimumCharacters = 4, maximumCharacters = 60} = {}) {
  const words = alignedWords(event).slice(-maximumWords), windows = [];
  for (let end = 0; end < words.length; end++) {
    let text = '';
    for (let start = end; start >= Math.max(0, end - windowWords + 1); start--) {
      text = words[start].text + text;
      const size = normalizeText(text).length;
      if (size > maximumCharacters) break;
      if (size < minimumCharacters) continue;
      windows.push({...event, words: words.slice(start, end + 1), text,
        startMs: words[start].startMs, endMs: words[end].endMs,
        firstWordId: words[start].id, lastWordId: words[end].id});
    }
  }
  return windows;
}
module.exports = {timedWords, alignedWords, wordSpeech, freshSpeech, wordWindows};
