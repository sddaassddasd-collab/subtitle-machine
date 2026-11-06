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

test('early reacquisition can finish a literally located same-cue sentence while preserving the next-cue handoff', () => {
  const p = new CaptionPresentation(), entries = [{id: 'a', text: '因為你們根本就沒有根據', startMs: 1000, endMs: 2000, isFinal: false}];
  p.publish(entries); p.reacquired(1, entries, 1000, 1800, 'scene');
  const text = '因為你們根本就沒有根據現在的情境', candidate = {index: 1, confidence: .81, matchedCharacters: 13,
    evidence: 16, heard: text, length: 18};
  assert.equal(p.revise({itemId: 'a', text, startMs: 1000, endMs: 3000,
    words: [{word: entries[0].text, start: 1, end: 2}, {word: '現在的情境', start: 2.1, end: 3}]},
  {index: 1, candidate}), true);
  assert.equal(p.held.entry.text, text); assert.equal(p.held.entry.endMs, 3000);
  p.revise({itemId: 'a', text: text + '下一句的內容', startMs: 1000, endMs: 4000,
    words: [{word: text, start: 1, end: 3}, {word: '下一句的內容', start: 3.1, end: 4}]},
  {index: 2, candidate: {...candidate, index: 2}});
  assert.equal(p.held.entry.text, text); assert.equal(p.held.entry.endMs, 3000);
  p.advance(2, 'scene'); assert.equal(p.held, null);
});

test('an uncertain, phonetic or mismatched continuation cannot extend a held caption', () => {
  for (const candidate of [{index: 1, confidence: .7}, {index: 1, phonetic: true}, {index: 2}, {index: 1, trailingCharacters: 1}]) {
    const p = new CaptionPresentation(), entries = [{id: 'a', text: '因為你們根本就沒有根據', startMs: 1000, endMs: 2000, isFinal: false}];
    p.publish(entries); p.reacquired(1, entries, 1000, 1800, 'scene');
    const text = entries[0].text + '現在的情境';
    p.revise({itemId: 'a', text, startMs: 1000, endMs: 3000,
      words: [{word: entries[0].text, start: 1, end: 2}, {word: '現在的情境', start: 2.1, end: 3}]},
    {index: 1, candidate: {index: 1, confidence: .9, matchedCharacters: 14, evidence: 16, heard: text, length: 18, ...candidate}});
    assert.equal(p.held.entry.text, entries[0].text); assert.equal(p.held.entry.endMs, 2000);
  }
});
