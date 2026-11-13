const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTracker, prepareScript, followTranscript} = require('../src/auto-follow');
const {forwardRejection, pauseRecovery, provisionalLocation} = require('../src/location-safety');
const {backwardRecovery} = require('../src/backward-recovery');
const fixture = require('./fixtures/location-safety-rehearsals.json');
function replay(name) {
  const scenario = fixture.cases.find(c => c.name === name), tracker = createTracker();
  let index = scenario.selectedIndex; const results = new Map();
  for (const e of scenario.events) {
    const result = followTranscript(tracker, fixture.lines, index,
      {...e, streamId: 'provider', startMs: e.audioStartMs, endMs: e.audioEndMs});
    if (Number.isInteger(result.index)) index = result.index;
    results.set(e.sequence, {index, result});
  }
  return results;
}
test('recorded common phrase does not skip from grid 197 to 207 or trap later grid 200', () => {
  const r = replay('shared-forward');
  for (const [seq, entry] of r) if (seq < 11044) assert.ok(entry.index < 206, `premature grid 207 at ${seq}`);
  assert.equal(r.get(10653).result.reason, 'insufficient_forward_evidence');
  assert.equal(r.get(10740).index, 199);
  assert.notEqual(r.get(10740).result.reason, 'backward_support_required');
});
test('recorded shared starry-sky opening does not fabricate multiple path steps', () => {
  const r = replay('shared-prefix');
  assert.equal(r.get(7657).index, 146);
  assert.equal(r.get(7657).result.index, undefined);
  assert.equal(r.get(7691).index, 146);
  assert.notEqual(r.get(7691).result.reason, 'same_item_rewind');
  let last = -1;
  for (const {index} of r.values()) {assert.ok(index >= last); last = index;}
});
test('recorded short suffix does not pull grid 5 back to grid 2', () => {
  const r = replay('near-suffix');
  assert.equal(r.get(396).index, 4);
  assert.equal(r.get(396).result.reason, 'backward_support_required');
});
for (const [name, sequence, index] of [['pause-city', 9539, 173], ['pause-body', 14969, 258]]) {
  test(`recorded ${name} reacquires from a final literal cue after the anchor expired`, () => {
    const r = replay(name).get(sequence);
    assert.equal(r.index, index); assert.equal(r.result.reason, 'pause_reacquired');
  });
}
for (const mode of ['valid', 'interim', 'untimed', 'ambiguous', 'music', 'incomplete', 'no-anchor', 'recent']) {
  test(`stale anchor reacquisition: ${mode}`, () => {
    const lines = ['已經確認的前一段台詞', '', '這是一句明確完整而獨特的台詞'].map((text, i) => ({text, type: i === 1 ? 'direction' : 'dialogue'}));
    const tracker = {textAnchor: {index: 0, atMs: 1000, literal: true}};
    const event = {text: lines[2].text, itemId: 'new', startMs: 40000, endMs: 42000, isFinal: true,
      words: [{word: lines[2].text, startMs: 40000, endMs: 42000}]};
    const candidate = {index: 2, confidence: 1, heard: event.text, evidence: event.text.length};
    if (mode === 'interim') event.isFinal = false;
    if (mode === 'untimed') event.words = [];
    if (mode === 'music') lines[1].music = true;
    if (mode === 'incomplete') candidate.heard = '這是一句明確';
    if (mode === 'no-anchor') tracker.textAnchor = null;
    if (mode === 'recent') tracker.textAnchor.atMs = 39000;
    assert.equal(pauseRecovery(tracker, prepareScript(lines), 0, candidate, event, mode === 'ambiguous'), mode === 'valid');
  });
}
for (const mode of ['valid', 'overlap', 'same-item', 'expired', 'outside-origin', 'weak', 'untimed']) {
  test(`provisional location may be corrected without trusting the mistaken display: ${mode}`, () => {
    const lines = Array.from({length: 12}, (_, i) => ({text: `這是其他不同的台詞${i}`}));
    lines[3].text = '他看到了掛在鞋子上的名牌'; lines[10].text = '那段尚未完整確認的新位置';
    const script = prepareScript(lines);
    const tracker = {textAnchor: {index: 0, atMs: 1000, literal: true}};
    const first = {text: '尚未完整確認的新', itemId: 'first', startMs: 2000, endMs: 3000};
    const candidate = {index: 10, confidence: 1, heard: first.text, evidence: 9};
    assert.equal(provisionalLocation(tracker, script, 0, candidate, first, []), true);
    assert.equal(tracker.textAnchor.index, 0);
    const start = mode === 'expired' ? 124000 : mode === 'overlap' ? 2500 : 4000;
    const text = lines[3].text;
    const next = {text, itemId: mode === 'same-item' ? 'first' : 'next', startMs: start, endMs: start + 1000,
      words: mode === 'untimed' ? [] : [{word: text, startMs: start, endMs: start + 1000}]};
    if (mode === 'outside-origin') tracker.provisionalLocation.fromIndex = 4;
    const result = backwardRecovery(tracker, script, 10, next, {index: 3, confidence: mode === 'weak' ? .7 : 1,
      heard: text, evidence: text.length, length: text.length, offset: text.length}, false);
    assert.equal(result.allowed, mode === 'valid');
    if (mode === 'valid') assert.equal(result.correctingProvisional, true);
  });
}
test('complete multi-cue proof and a unique full cue retain forward catch-up', () => {
  const lines = ['第一段目前已經說完了', '第二段也已經完整說完', '第三段有新的內容'].map(text => ({text}));
  const script = prepareScript(lines);
  assert.equal(forwardRejection(script, 0, {index: 2, heard: lines[2].text, confidence: 1, evidence: 10}, {text: lines[2].text}, []), null);
  assert.equal(forwardRejection(script, 0, {index: 2, heard: '第三段', confidence: 1, evidence: 3}, {text: '第三段'},
    [{index: 0, completed: true}, {index: 1, completed: true}]), null);
});

test('a far partial recovery remains provisional and can return to a newly proved cue in the original corridor', () => {
  const lines = Array.from({length: 12}, (_, i) => ({text: `完全不同的另一段台詞${i}`}));
  lines[0].text = '我先把這段故事說清楚';
  lines[3].text = '他看到了鞋子上的那塊名牌';
  lines[10].text = '眼前這個奇怪的名字讓他想起一段故事';
  const tracker = createTracker(); let current = 0;
  const say = (text, itemId, startMs, endMs) => {
    const result = followTranscript(tracker, lines, current, {text, itemId, streamId: 's', startMs, endMs,
      isFinal: true, words: [{word: text, startMs, endMs}]});
    if (Number.isInteger(result.index)) current = result.index;
    return result;
  };
  say(lines[0].text, 'anchor', 0, 1000);
  const partial = say('眼前這個奇怪的名字', 'partial', 5000, 7000);
  assert.equal(current, 10); assert.equal(partial.candidate.provisionalLocation, true);
  assert.equal(tracker.textAnchor.index, 0); assert.equal(tracker.preparedIndex, null);
  assert.equal(partial.completed, false);
  const correction = say(lines[3].text, 'correct', 8000, 10000);
  assert.equal(current, 3); assert.equal(correction.reason, 'provisional_location_corrected');
  assert.equal(tracker.provisionalLocation, null);
});

test('expiration or another partial cue cannot silently promote a provisional location', () => {
  const script = prepareScript(Array.from({length: 12}, (_, i) => ({text: `完整而不同的劇本台詞內容${i}`})));
  const tracker = {textAnchor: {index: 0, atMs: 1000}, provisionalLocation: {fromIndex: 0, index: 9, itemId: 'old', endMs: 3000}};
  const earlierSnapshot = tracker.provisionalLocation;
  assert.equal(provisionalLocation(tracker, script, 9, {index: 10, confidence: 1, heard: '劇本台詞', evidence: 4},
    {text: '劇本台詞', itemId: 'new', startMs: 130000, endMs: 131000}, []), true);
  assert.equal(tracker.provisionalLocation.expired, true);
  assert.equal(earlierSnapshot.index, 9);
  assert.equal(earlierSnapshot.expired, undefined);
  assert.equal(tracker.provisionalLocation.endMs, 3000);
  assert.equal(tracker.textAnchor.index, 0);
});
