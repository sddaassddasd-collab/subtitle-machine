const {test} = require('node:test');
const assert = require('node:assert/strict');
const {observeScriptPath} = require('../src/script-path');
const {prepareScript, createTracker} = require('../src/auto-follow');
const script = prepareScript(Array.from({length: 10}, (_, i) => ({text: `不同的台詞內容${i}`})));
const candidate = index => ({index, confidence: .95, rank: .95, evidence: 4, offset: 4, length: 8, heard: `台詞${index}`});
const event = (itemId, startMs, endMs) => ({itemId, startMs, endMs});
test('duplicate, overlapping and expired observations cannot fabricate recovery evidence', () => {
  for (const second of [event('a', 0, 2000), event('b', 500, 2000), event('b', 20000, 21000)]) {
    const tracker = createTracker();
    observeScriptPath(tracker, script, 0, [candidate(3)], event('a', 0, 1000));
    assert.equal(observeScriptPath(tracker, script, 0, [candidate(4)], second), null);
  }
  const tracker = createTracker();
  for (let i = 1; i < 6; i++) assert.equal(observeScriptPath(tracker, script, 0, [candidate(3)], event('a', 0, i * 1000)), null);
});
test('competing equal forward paths remain ambiguous and do not jump', () => {
  const tracker = createTracker();
  observeScriptPath(tracker, script, 0, [candidate(2), candidate(5)], event('a', 0, 1000));
  assert.equal(observeScriptPath(tracker, script, 0, [candidate(3), candidate(6)], event('b', 1000, 2000)), null);
});

const {observeWeakScriptPath} = require('../src/script-path');
function anchoredTracker() {
  const t = createTracker(); t.lastLocated = {index: 0, atMs: 500, confidence: 1, literal: true}; return t;
}
const weak = index => ({...candidate(index), confidence: .74, rank: .74, evidence: 7, matchedCharacters: 5});
test('three ordered weak cues require a recent literal anchor and never reuse an ASR item', () => {
  const t = anchoredTracker();
  assert.equal(observeWeakScriptPath(t, script, 0, [weak(2)], event('a', 500, 1000)), null);
  assert.equal(observeWeakScriptPath(t, script, 0, [weak(3)], event('b', 1000, 2000)), null);
  const r = observeWeakScriptPath(t, script, 0, [weak(4)], event('c', 2000, 3000));
  assert.equal(r.index, 4); assert.equal(r.weakPath, true);
  assert.equal(t.path.hypotheses.length, 0, 'normal path is independent');
  for (const mode of ['no_anchor', 'expired', 'same_item', 'overlap', 'music', 'direction', 'ambiguous']) {
    const tracker = mode === 'no_anchor' ? createTracker() : anchoredTracker();
    const entries = script.entries.map(e => ({...e, source: {...e.source}}));
    if (mode === 'music') entries[1].source.music = true;
    if (mode === 'direction') entries[1].source.type = 'direction';
    let result;
    for (let i = 0; i < 3; i++) {
      const start = mode === 'expired' ? 35000 + i * 1000 : mode === 'overlap' ? 500 : 500 + i * 1000;
      const choices = [weak(i + 2), ...(mode === 'ambiguous' ? [weak(i + 3)] : [])];
      result = observeWeakScriptPath(tracker, {...script, entries}, 0, choices,
        event(mode === 'same_item' ? 'a' : `a${i}`, start, start + 1000 + (mode === 'overlap' ? i * 1000 : 0)));
    }
    assert.equal(result, null, mode);
  }
});
