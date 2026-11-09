const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTracker, followTranscript, prepareScript} = require('../src/auto-follow');
const {backwardRecovery} = require('../src/backward-recovery');
const rehearsal = require('./fixtures/backward-rehearsal.json');

test('recorded grid 506 suffix cannot rewind to grid 477', () => {
  const tracker = createTracker(); let current = rehearsal.selectedIndex, result;
  for (const e of rehearsal.events) {
    result = followTranscript(tracker, rehearsal.lines, current,
      {...e, streamId: 's', startMs: e.audioStartMs, endMs: e.audioEndMs});
    if (Number.isInteger(result.index)) current = result.index;
  }
  assert.equal(current + rehearsal.firstIndex + 1, 506);
  assert.equal(result.reason, 'backward_support_required');
  assert.equal(tracker.backwardRecovery.index + rehearsal.firstIndex + 1, 477);
});

for (const mode of ['same-item', 'overlap', 'expired', 'withdrawn', 'ambiguous', 'music', 'direction', 'origin-changed', 'untimed']) {
  test(`distant rewind rejects ${mode} evidence`, () => {
    const lines = Array.from({length: 12}, (_, i) => ({text: `這是其他不同的台詞${i}`}));
    lines[0].text = '記得我們共同許下的約定'; lines[1].text = '接著一起走向明天的道路';
    const tracker = {}, script = prepareScript(lines);
    const event = (index, itemId, startMs, endMs) => ({text: lines[index].text, itemId, startMs, endMs,
      isFinal: true, words: [{word: lines[index].text, startMs, endMs}]});
    const candidate = index => ({index, confidence: 1, evidence: 12, heard: lines[index].text, length: 12, offset: 12});
    backwardRecovery(tracker, script, 10, event(0, 'old', 1000, 2000), candidate(0), false);
    assert.ok(tracker.backwardRecovery);
    if (mode === 'withdrawn') backwardRecovery(tracker, script, 10,
      {...event(0, 'old', 1000, 2100), text: '完全不一樣的改稿', words: []}, null, false);
    if (mode === 'music') script.entries[1].source.music = true;
    if (mode === 'direction') script.entries[1].source.type = 'direction';
    const start = mode === 'expired' ? 13000 : mode === 'overlap' ? 1800 : 2500;
    const next = event(1, mode === 'same-item' ? 'old' : 'new', start, start + 1000);
    if (mode === 'untimed') next.words = [];
    const result = backwardRecovery(tracker, script, mode === 'origin-changed' ? 11 : 10, next, candidate(1), mode === 'ambiguous');
    assert.equal(result.allowed, false);
  });
}

test('a pending distant replay does not spend a prepared opening before its independent successor', () => {
  const lines = Array.from({length: 12}, (_, i) => ({text: `這是其他不同的台詞${i}`}));
  lines[0].text = '記得我們共同許下的約定'; lines[1].text = '接著一起走向明天的道路';
  lines[10].text = '目前這句已經完整說完了';
  const tracker = createTracker(); let current = 10;
  function say(index, id, startMs, endMs) {
    const text = lines[index].text;
    const result = followTranscript(tracker, lines, current,
      {text, streamId: 's', itemId: id, startMs, endMs, isFinal: true, words: [{word: text, startMs, endMs}]});
    if (Number.isInteger(result.index)) current = result.index;
    return result;
  }
  say(10, 'anchor', 0, 1000);
  assert.equal(tracker.preparedIndex, 11);
  assert.equal(say(0, 'first', 2000, 3000).reason, 'backward_support_required');
  assert.equal(current, 10);
  const restored = say(1, 'next', 3500, 4500);
  assert.equal(restored.reason, 'independent_backward_recovery');
  assert.equal(current, 1);
  assert.equal(tracker.preparedIndex, null);
});
