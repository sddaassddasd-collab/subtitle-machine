const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evaluateAcoustic} = require('../src/acoustic-evaluation');
const {phrasePcm, phrases} = require('./helpers/reference-audio');

test('offline replay measures short-cue transitions with the production streaming path', () => {
  const sequence = [...phrases[0], ...phrases[1], ...phrases[0]];
  const segments = [
    {lineId: 'a', index: 0, start: 0, end: 1.44, status: 'auto'},
    {lineId: 'b', index: 1, start: 1.44, end: 2.16, status: 'review'},
    {lineId: 'c', index: 2, start: 2.16, end: 4.32, status: 'auto'},
    {lineId: 'missing', index: 3, start: null, end: null, status: 'unmatched'},
  ];
  const report = evaluateAcoustic({referencePcm: phrasePcm(sequence), livePcm: phrasePcm(sequence, 24000),
    segments, liveTimeline: segments.slice(0, 3).map(s => ({index: s.index, start: s.start}))});
  assert.deepEqual(report.transitions.map(t => t.index), [1, 2]);
  assert.equal(report.groundTruthAvailable, true);
  assert.ok(report.rows[1].entryErrorSeconds >= 0);
  assert.equal(report.rows[3].usable, false);
  assert.equal(report.rows[3].entryErrorSeconds, null);
  assert.equal(report.algorithms.acoustic, 4);
});

test('a second performance without annotations reports observations, not invented accuracy', () => {
  const report = evaluateAcoustic({referencePcm: phrasePcm(phrases[0]), livePcm: phrasePcm(phrases[1], 24000),
    segments: [{lineId: 'a', index: 0, start: 0, end: 1.44, status: 'auto'}]});
  assert.equal(report.groundTruthAvailable, false);
  assert.equal(report.rows[0].entryErrorSeconds, null);
  assert.equal(report.accepted, 0);
});
