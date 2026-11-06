const {test} = require('node:test');
const assert = require('node:assert/strict');
const {timedWords, alignedWords, wordSpeech, freshSpeech} = require('../src/word-evidence');
const {createTracker, prepareScript, followTranscript, applySemanticLocation} = require('../src/auto-follow');
const {observeWordPath} = require('../src/word-path');

function timed(texts, startMs = 1200) {
  return texts.map((word, i) => ({word, start: (startMs + i * 400) / 1000, end: (startMs + (i + 1) * 400) / 1000}));
}
const event = (text, extra = {}) => ({text, streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, ...extra});

test('word IDs map back to actual provider times, without inventing times for unavailable or inconsistent words', () => {
  const e = event('你們的論點既是對的', {endMs: 3000, words: timed(['你們的', '論點', '既是', '對的'], 1200)});
  const span = wordSpeech(e, 2, 3);
  assert.equal(span.text, '既是對的'); assert.equal(span.startMs, 2000); assert.equal(span.endMs, 2800);
  assert.equal(wordSpeech(e, 9, 10), null); assert.equal(wordSpeech(e, 3, 2), null);
  assert.equal(wordSpeech({...e, words: []}, 0, 1), null);
  assert.deepEqual(timedWords({...e, words: [{word: '你們的', start: 1, end: 2}, {word: '論點', start: 1.5, end: 2.5}]}), []);
  assert.deepEqual(alignedWords({...e, text: '完全不同的辨識內容'}), []);
  assert.equal(freshSpeech(e, 2000).text, '既是對的');
});
test('disjoint word ranges inside one ASR item form a path, but overlapping revisions do not', () => {
  const script = prepareScript(['已確認的開頭台詞', '下一句明確的內容', '後面另一句台詞'].map(text => ({text})));
  const candidate = (index, startMs, endMs) => ({index, confidence: .95, rank: .95, matchedCharacters: 6,
    speech: {startMs, endMs, firstWordId: index, lastWordId: index}, evidence: 6});
  const tracker = createTracker(); tracker.textAnchor = {index: 0, atMs: 0, literal: true, confidence: 1};
  const e = {revisionId: 'same-revision', endMs: 3000};
  const result = observeWordPath(tracker, script, 0, [candidate(1, 1000, 2000), candidate(2, 2000, 3000)], e);
  assert.equal(result.index, 2);
  assert.equal(result.wordWitnesses[0].inputId, result.wordWitnesses[1].inputId);
  for (const overlap of [true, false]) {
    const t = createTracker(); t.textAnchor = tracker.textAnchor;
    assert.equal(observeWordPath(t, script, 0, [candidate(1, 1000, 2000)], e), null);
    const next = candidate(2, overlap ? 1500 : 1000, overlap ? 2500 : 2000);
    assert.equal(observeWordPath(t, script, 0, [next], {...e, revisionId: 'revised'}), null);
  }
});
test('a growing item covering two imperfect script cues recovers using real word ranges and does not arm an onset', () => {
  const lines = ['今天大家一起準備演出', '這件事讓我變得更緊張', '反而寫不出任何東西', '接下來請你繼續說'].map(text => ({text}));
  const t = createTracker();
  followTranscript(t, lines, 0, event(lines[0].text));
  const parts = ['這', '整件事情', '讓我', '更加的', '緊張', '反而', '寫', '不', '出', '更', '多'];
  const words = timed(parts);
  const r = followTranscript(t, lines, 0, event(parts.join(''), {itemId: 'b', startMs: 1200, endMs: 5600,
    words, revisionId: 'one-growing-item'}));
  assert.equal(r.index, 2); assert.equal(r.reason, 'word_span_recovery');
  assert.equal(r.completed, false); assert.equal(r.armedIndex, null); assert.deepEqual(r.spans, []);
  assert.ok(r.candidate.wordWitnesses.every((w, i, all) => !i || w.startMs >= all[i - 1].endMs));
});
test('common method fragments cannot jump to an unspoken later cue', () => {
  const lines = ['並且在這期間使用搔癢療法進行治療。', '你又來了，這樣根本沒用。', '你的方法才沒用！'].map(text => ({text}));
  const t = createTracker(); followTranscript(t, lines, 0, event('在這期間使用'));
  const parts = ['期', '然後', '在這個', '期間', '呢', '使用', '了', '那個', '搔', '癢', '搔', '癢', '的方法', '進行'];
  const r = followTranscript(t, lines, 0, event(parts.join(''), {itemId: 'b', startMs: 1200, endMs: 6800, words: timed(parts)}));
  assert.notEqual(r.index, 2, '癢的方法 shares only three characters with 你的方法才沒用');
});
test('a locally unique short anchor survives a pause and allows a globally unique five-character recovery', () => {
  const texts = ['都因為我的搔癢治療得到了很大的進展', '你這樣只是治標不治本', '你才只是在散播恐懼', '不不不', '兩位專家', '先冷靜下來', '你們的論點'];
  for (const mode of ['valid', 'expired', 'duplicate', 'direction', 'music', 'manual']) {
    const lines = texts.map(text => ({text}));
    if (mode === 'duplicate') lines.push({text: texts[6]});
    if (mode === 'direction') lines[3].type = 'direction';
    if (mode === 'music') lines[3].music = true;
    let t = createTracker();
    followTranscript(t, lines, 0, event('搔癢治療'));
    assert.equal(t.textAnchor?.index, 0);
    if (mode === 'manual') t = createTracker({ignoreBeforeMs: 19000});
    const startMs = mode === 'expired' ? 32000 : 20000;
    const r = followTranscript(t, lines, 0, event('你們的論點', {itemId: 'b', startMs, endMs: startMs + 1000}));
    if (mode === 'valid') {
      assert.equal(r.index, 6); assert.equal(r.reason, 'short_exact_recovery');
      assert.equal(r.completed, false); assert.equal(r.armedIndex, null);
    } else assert.notEqual(r.index, 6, mode);
  }
});
test('one-character changes in the next short cue require fresh speech and remain ambiguous when another cue fits', () => {
  for (const mode of ['valid', 'overlap', 'ambiguous', 'no_context']) {
    const t = createTracker(), lines = [{text: '既是對的'}, {text: '又是錯的'}, {text: '後面的另一句話'}];
    t.streamId = 's';
    if (mode === 'ambiguous') lines[2].text = '也是錯的';
    if (mode !== 'no_context') applySemanticLocation(t, lines, 0, {itemId: 'a', text: '其實對的', endMs: 1000});
    const r = followTranscript(t, lines, 0, event('也是錯的', {itemId: 'b', startMs: mode === 'overlap' ? 500 : 1200, endMs: 2000}));
    if (mode === 'valid') { assert.equal(r.index, 1); assert.equal(r.reason, 'contextual_short_next'); assert.equal(r.armedIndex, null); }
    else assert.notEqual(r.reason, 'contextual_short_next', mode);
  }
});

test('a withdrawn word hypothesis cannot support a later cue after the same audio is rewritten', () => {
  const script = prepareScript(['已確認的開頭台詞', '第一個清楚台詞', '後續清楚的台詞'].map(text => ({text})));
  const tracker = createTracker(); tracker.textAnchor = {index: 0, atMs: 0, literal: true, confidence: 1};
  const a = {itemId: 'a', revisionId: 'first', text: '第一個清楚台詞', startMs: 0, endMs: 1000,
    words: [{word: '第一個清楚台詞', start: 0, end: 1}]};
  const first = {index: 1, confidence: 1, rank: 1, matchedCharacters: 7, evidence: 7,
    speech: wordSpeech(a, 0, 0)};
  assert.equal(observeWordPath(tracker, script, 0, [first], a), null);
  const b = {itemId: 'a', revisionId: 'rewritten', text: '完全不同內容後續清楚的台詞', startMs: 0, endMs: 2000,
    words: [{word: '完全不同內容', start: 0, end: 1}, {word: '後續清楚的台詞', start: 1, end: 2}]};
  const second = {index: 2, confidence: 1, rank: 1, matchedCharacters: 7, evidence: 7,
    speech: wordSpeech(b, 1, 1)};
  assert.equal(observeWordPath(tracker, script, 0, [second], b), null);
  assert.ok(!tracker.wordPath.hypotheses.some(h => h.steps > 1));
  assert.deepEqual(timedWords({...b, words: [null]}), []);
});
