const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evaluatePerformance} = require('../src/performance-evaluation');
const lines = [{text: '我們今天開始演出'}, {text: '請你坐下來喝杯茶'}];
const cues = [{index: 0, startMs: 0, endMs: 2000}, {index: 1, startMs: 2000, endMs: 4000}];
const revisions = lines.map((line, i) => ({itemId: String(i), text: line.text, startMs: i * 2000,
  endMs: i * 2000 + 1000, receivedMs: i * 2000 + 1200, isFinal: true}));
test('annotated model comparison distinguishes correct content, missed cues and arrival latency', () => {
  const r = evaluatePerformance({lines, cues, spokenText: lines.map(l => l.text).join(''),
    runs: [{name: 'clear', revisions}, {name: 'failed', revisions: revisions.map(r => ({...r, text: '完全辨識錯誤'}))}]}).results;
  assert.equal(r[0].characterErrorRate, 0);
  assert.equal(r[0].locatedDuringCue, 2);
  assert.equal(r[0].rows[1].firstLocationDelayMs, 1200);
  assert.equal(r[1].missedCues, 2);
  assert.ok(r[1].characterErrorRate > 0);
});
test('interim revisions are not counted twice in final character error rate', () => {
  const r = evaluatePerformance({lines, cues, spokenText: lines.map(l => l.text).join(''), runs: [{name: 'revisions',
    revisions: [{...revisions[0], text: '我們今天開始', receivedMs: 1100, isFinal: false}, ...revisions]}]}).results[0];
  assert.equal(r.finalizedItems, 2);
  assert.equal(r.characterErrorRate, 0);
  assert.throws(() => evaluatePerformance({lines, cues, spokenText: '文字', runs: [{revisions: [{text: '文字'}]}]}), /receivedMs/);
});
test('whole-file offline outputs can score text but never invent streaming latency', () => {
  const result = evaluatePerformance({lines, cues, spokenText: lines.map(l => l.text).join(''),
    runs: [{name: 'offline', mode: 'offline', segments: lines.map(l => ({text: l.text}))}]}).results[0];
  assert.equal(result.characterErrorRate, 0);
  assert.equal(result.firstLocationDelayMs, undefined);
  assert.equal(result.mode, 'offline');
});
