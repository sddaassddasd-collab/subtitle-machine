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
