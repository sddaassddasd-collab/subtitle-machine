const {test} = require('node:test');
const assert = require('node:assert/strict');
const {supportedRecovery} = require('../src/supported-recovery');

for (const [name, currentIndex, endMs] of [['expired audio', 1, 10001], ['changed origin', 5, 2500]]) {
  test(`pending recovery clears on ${name} even without aligned words`, () => {
    const tracker = {supportedRecovery: {fromIndex: 1, index: 3, itemId: 'old', endMs: 2000}};
    assert.equal(supportedRecovery(tracker, {entries: []}, currentIndex,
      {text: '新的辨識文字', itemId: 'new', startMs: endMs - 500, endMs}, []), null);
    assert.equal(tracker.supportedRecovery, null);
  });
}

const {prepareScript, localSupportCandidates} = require('../src/auto-follow');
for (const mode of ['partial', 'nearby', 'predicted-current', 'ambiguous', 'negation', 'same-item', 'overlap', 'expired', 'untimed']) {
  test(`ordered weak cue recovery: ${mode}`, () => {
    const script = prepareScript(['目前這段已經確定了', '你們根本沒有找到問題真正的核心了',
      '現在的問題在於他的心情', mode === 'ambiguous' ? '現在的問題出在另一件事情' : '完全不同的其他故事'].map(text => ({text})));
    const tracker = {textAnchor: {index: 0, atMs: 1000}, located: true};
    const locate = part => localSupportCandidates(script, 0, part.text, {ahead: 6, phoneticMinimum: .65});
    const text = '你們根本沒有找到情緒真正的根源了';
    const first = {text, itemId: 'old', startMs: 2000, endMs: 4000, words: [{word: text, startMs: 2000, endMs: 4000}]};
    supportedRecovery(tracker, script, 0, first, locate(first), locate);
    assert.equal(tracker.supportedRecovery?.index, 1, 'immediate next cue may be retained as a hypothesis');
    let current = 0;
    if (mode === 'predicted-current') {current = 1; tracker.prediction = {fromIndex: 0};}
    const startMs = mode === 'expired' ? 14000 : mode === 'overlap' ? 3500 : 4500;
    const heard = mode === 'negation' ? '現在沒有問題' : '現在的問題';
    const next = {text: heard, itemId: mode === 'same-item' ? 'old' : 'new', startMs, endMs: startMs + 1000,
      words: mode === 'untimed' ? [] : [{word: heard, startMs, endMs: startMs + 1000}]};
    const result = supportedRecovery(tracker, script, current, next, locate(next), locate);
    if (['partial', 'nearby', 'predicted-current'].includes(mode)) {
      assert.equal(result.index, 2);
      assert.equal(result.speech.startMs, startMs);
      assert.equal(result.candidate.evidence, 5);
    } else assert.equal(result, null);
  });
}

test('partial successor uses its actual word range inside a longer ASR item', () => {
  const script = prepareScript(['這句目前已經確定了', '你們根本沒有找到問題真正的核心了', '現在的問題在於他的心情'].map(text => ({text})));
  const tracker = {textAnchor: {index: 0, atMs: 1000}, located: true};
  const locate = part => localSupportCandidates(script, 0, part.text, {ahead: 6, phoneticMinimum: .65});
  const weak = '你們根本沒有找到情緒真正的根源了';
  const first = {text: weak, itemId: 'old', startMs: 2000, endMs: 4000, words: [{word: weak, startMs: 2000, endMs: 4000}]};
  supportedRecovery(tracker, script, 0, first, locate(first), locate);
  const next = {text: '額外的開場完全是隨口加上的現在的問題', itemId: 'new', startMs: 4500, endMs: 6500,
    words: [{word: '額外的開場完全是隨口加上的', startMs: 4500, endMs: 5900}, {word: '現在的問題', startMs: 5900, endMs: 6500}]};
  const result = supportedRecovery(tracker, script, 0, next, locate(next), locate);
  assert.equal(result.index, 2);
  assert.equal(result.speech.text, '現在的問題');
  assert.equal(result.speech.startMs, 5900);
  assert.equal(result.speech.endMs, 6500);
});
