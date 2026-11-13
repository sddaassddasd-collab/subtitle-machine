const {test} = require('node:test');
const assert = require('node:assert/strict');
const {locationEvidence} = require('../src/location-evidence');
const {ShadowFollow} = require('../src/shadow-follow');
test('a matched suffix records its containing provider word clocks and IDs', () => {
  const event = {text: '上一句現在開始', startMs: 1000, endMs: 3000, words: [
    {word: '上一句', startMs: 1100, endMs: 1500}, {word: '現在', startMs: 1700, endMs: 2100}, {word: '開始', startMs: 2300, endMs: 2700}]};
  const evidence = locationEvidence(event, {heard: '在開始'});
  assert.equal(evidence.startMs, 1700); assert.equal(evidence.endMs, 2700);
  assert.equal(evidence.firstWordId, 1); assert.equal(evidence.lastWordId, 2);
  assert.equal(evidence.kind, 'provider_word_range');
  assert.equal(evidence.text, '現在開始');
});
test('a history-based match does not invent clocks for the historical words', () => {
  const evidence = locationEvidence({text: '開始', startMs: 2000, endMs: 3000,
    words: [{word: '開始', startMs: 2100, endMs: 2700}]}, {heard: '現在開始', context: true});
  assert.equal(evidence.startMs, 2100); assert.equal(evidence.endMs, 2700);
  assert.equal(evidence.includesHistory, true);
  assert.equal(evidence.scope, 'current_revision_of_context_match');
  assert.equal(evidence.matchedText, '現在開始'); assert.equal(evidence.text, '開始');
});
test('untimed evidence is explicitly a transcript range', () => {
  const evidence = locationEvidence({text: '現在開始', startMs: 1000, endMs: 2000}, {heard: '現在開始'});
  assert.equal(evidence.kind, 'transcript_range');
  assert.equal(evidence.firstWordId, null);
  assert.equal(evidence.startMs, 1000); assert.equal(evidence.endMs, 2000);
});
test('shadow reports explicit reliability booleans and evidence even when uncertain', () => {
  const reports = [], work = [];
  const shadow = new ShadowFollow({record: report => reports.push(report), schedule: task => {work.push(task); return task;}});
  for (const [i, text] of ['目前這句已經完整說完了', '不相干', '啊'].entries()) {
    shadow.enqueue({lines: [{text: '目前這句已經完整說完了'}], seedIndex: 0, streamId: 'capture',
      event: {text, itemId: `a${i}`, streamId: 'provider', startMs: i * 1500, endMs: i * 1500 + 1000, isFinal: true},
      display: {index: 0, source: 'script'}});
  }
  while (work.length) work.shift()();
  for (const report of reports) {
    assert.equal(typeof report.locator.reliable, 'boolean');
    assert.equal(typeof report.requiresReview, 'boolean');
    assert.ok(Number.isFinite(report.locator.evidence.startMs));
    assert.ok(Number.isFinite(report.locator.evidence.endMs));
  }
  shadow.dispose();
});
