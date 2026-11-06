const {test} = require('node:test');
const assert = require('node:assert/strict');
const {CaptionPresentation} = require('../src/caption-presentation');

test('short interim text leaves the published caption intact until a readable phrase stabilizes', () => {
  const p = new CaptionPresentation();
  assert.deepEqual(p.publish([{id: 'a', text: '好', isFinal: false}], 0), []);
  assert.deepEqual(p.publish([{id: 'a', text: '好要饒了你', isFinal: false}], 100), []);
  assert.equal(p.publish([{id: 'a', text: '好要饒了你', isFinal: false}], 400)[0].text, '好要饒了你');
  assert.equal(p.publish([{id: 'b', text: '嗯', isFinal: false}], 500)[0].id, 'a');
  assert.equal(p.publish([{id: 'b', text: '嗯', isFinal: true}], 600)[0].id, 'b');
});

test('a held caption accepts its own revision and cannot be overwritten by a different utterance', () => {
  const p = new CaptionPresentation(), entries = [{id: 'a', text: '其實跟核心', startMs: 1000, endMs: 2000, isFinal: true}];
  p.publish(entries, 0);
  assert.equal(p.reacquired(1, entries, 1100, 1900, 'scene'), true);
  assert.equal(p.revise({itemId: 'b', text: '下一句的草稿', startMs: 2100, endMs: 3000}), false);
  assert.equal(p.held.entry.text, '其實跟核心');
  assert.equal(p.revise({itemId: 'a', text: '其實更核心', startMs: 1000, endMs: 2000}), true);
  assert.equal(p.held.entry.text, '其實更核心');
  p.advance(2, 'scene'); assert.equal(p.held, null);
});

test('growing the same ASR item clips revisions at the held word range and retains its original fence', () => {
  const p = new CaptionPresentation(), entries = [{id: 'a', text: '其實跟核心', startMs: 1000, endMs: 2000, isFinal: true}];
  p.publish(entries); p.reacquired(1, entries, 1000, 2000, 'scene');
  assert.equal(p.revise({itemId: 'a', text: '其實更核心接著講下一句', startMs: 1000, endMs: 4000,
    words: [{word: '其實更核心', start: 1, end: 2}, {word: '接著講下一句', start: 2.1, end: 4}]}), true);
  assert.equal(p.held.entry.text, '其實更核心'); assert.equal(p.held.entry.endMs, 2000);
  assert.equal(p.revise({itemId: 'a', text: '其實更核心接著講下一句', startMs: 1000, endMs: 4000}), false);
  assert.equal(p.held.entry.text, '其實更核心');
});
