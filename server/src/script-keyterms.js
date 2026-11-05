const segmenter = new Intl.Segmenter('zh', {granularity: 'word'});
const STOP = new Set(['我們', '你們', '他們', '這個', '那個', '什麼', '就是', '可以', '沒有', '一個', '因為', '所以']);

function scriptKeyterms(lines, currentIndex, context = '') {
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
  String(context).split(/[\s,，、;；\n]+/u).forEach(add);
  const nearby = lines.slice(Math.max(0, currentIndex - 1), currentIndex + 9).filter(l => l.type !== 'direction' && !l.music);
  nearby.forEach(line => add(line.role));
  for (const line of nearby) for (const word of segmenter.segment(String(line.text || '')))
    if (word.isWordLike) add(word.segment);
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
  const terms = scriptKeyterms(lines, currentIndex, stream.transcriptionContext);
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
module.exports = {scriptKeyterms, refreshKeyterms, acknowledgeKeyterms};
