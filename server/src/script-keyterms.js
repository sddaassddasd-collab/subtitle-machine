const segmenter = new Intl.Segmenter('zh', {granularity: 'word'});
const STOP = new Set(['我們', '你們', '他們', '這個', '那個', '什麼', '就是', '可以', '沒有', '一個', '因為', '所以',
  '都是', '他的', '你的', '我的', '這裡', '那裡', '到了', '都能', '每個人', '自己', '現在', '這樣', '那樣']);
const scriptCache = new WeakMap();

function normalizeVocabulary(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\n,，、;；]+/u);
  return [...new Set(entries.filter(v => typeof v === 'string').map(v => v.trim())
    .filter(v => v.length >= 2 && v.length <= 24))].slice(0, 200);
}

function vocabularyIndex(lines) {
  if (scriptCache.has(lines)) return scriptCache.get(lines);
  const frequencies = new Map();
  const entries = lines.map(line => {
    if (line.type === 'direction' || line.music) return [];
    const words = [...segmenter.segment(String(line.text || ''))].filter(w => w.isWordLike)
      .map(w => w.segment).filter(w => w.length >= 2 && !STOP.has(w));
    for (const word of new Set(words)) frequencies.set(word, (frequencies.get(word) || 0) + 1);
    return words;
  });
  const result = {entries, frequencies};
  scriptCache.set(lines, result); return result;
}

function scriptKeyterms(lines, currentIndex, context = '', vocabulary = [], {nearby = true} = {}) {
  const terms = [], seen = new Set();
  let bytes = 0;
  const add = value => {
    const term = String(value || '').trim();
    const size = Buffer.byteLength(term);
    // A conservative byte budget stays within the provider's token budget,
    // without requiring a model-specific tokenizer or sending the whole play.
    if (term.length < 2 || term.length > 24 || STOP.has(term) || seen.has(term) || terms.length >= 32 || bytes + size > 400) return;
    seen.add(term); bytes += size; terms.push(term);
  };
  normalizeVocabulary(vocabulary).forEach(add);
  String(context).split(/[\s,，、;；\n]+/u).forEach(add);
  const localLines = lines.slice(Math.max(0, currentIndex - 1), currentIndex + 9).filter(l => l.type !== 'direction' && !l.music);
  localLines.forEach(line => add(line.role));
  if (!nearby) return terms;
  const index = vocabularyIndex(lines), ranked = new Map();
  for (let i = Math.max(0, currentIndex - 1); i < Math.min(lines.length, currentIndex + 9); i++) {
    for (const word of index.entries[i]) {
      const score = word.length * 2 - Math.log2(index.frequencies.get(word) || 1) - Math.abs(i - currentIndex) * .15;
      ranked.set(word, Math.max(ranked.get(word) ?? -Infinity, score));
    }
  }
  [...ranked].sort((a, b) => b[1] - a[1]).forEach(([word]) => add(word));
  return terms;
}

// Configure is optional and never blocks audio. One update may be in flight;
// failed/unsupported updates are disabled for this stream and logged.
function refreshKeyterms(stream, lines, currentIndex, emit, now = Date.now()) {
  const state = stream.scriptKeyterms;
  if (!state || state.disabled || !stream.ready || stream.closing || now - state.checkedAt < 1000) return;
  state.checkedAt = now;
  if (state.pending) {
    if (now - state.pendingAt > 5000) { state.disabled = true; emit('timeout', {terms: state.pending}); }
    return;
  }
  const terms = scriptKeyterms(lines, currentIndex, stream.transcriptionContext,
    stream.scriptVocabularyActive === false ? [] : stream.scriptVocabulary, {nearby: stream.scriptContextUncertain !== true});
  if (JSON.stringify(terms) === JSON.stringify(state.terms)) return;
  try {
    stream.socket.send(JSON.stringify({type: 'Configure', keyterms: terms}));
    state.pending = terms; state.pendingAt = now;
    emit('requested', {terms});
  } catch (error) {
    state.disabled = true; emit('failed', {error: String(error.message).slice(0, 200)});
  }
}

function acknowledgeKeyterms(stream, event, emit) {
  if (!['ConfigureSuccess', 'ConfigureFailure'].includes(event?.type) || !stream.scriptKeyterms?.pending) return false;
  const state = stream.scriptKeyterms;
  if (event.type === 'ConfigureSuccess') {
    state.terms = state.pending; emit('applied', {terms: state.terms});
  } else {
    state.disabled = true; emit('failed', {code: String(event.code || '').slice(0, 120)});
  }
  state.pending = null;
  return true;
}
module.exports = {scriptKeyterms, normalizeVocabulary, refreshKeyterms, acknowledgeKeyterms};
