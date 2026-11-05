const {test} = require('node:test');
const assert = require('node:assert/strict');
const {replayFollow} = require('../src/follow-replay');
test('text replay excludes recorded automatic decisions and does not claim ground truth', () => {
  const report = {events: [
    {type: 'context', contextId: 'c', lines: [{text: '我們今天開始演出'}, {text: '請你坐下來喝杯茶'}]},
    {type: 'cue_enter', contextId: 'c', index: 0, source: 'initial'},
    {type: 'cue_enter', contextId: 'c', index: 1, source: 'onset'},
    {type: 'transcript_revision', providerStreamId: 's', itemId: 'a', audioStartMs: 0,
      audioEndMs: 1000, text: '我們今天開始演出', isFinal: true, at: 1000},
  ]};
  const r = replayFollow(report);
  assert.equal(r.finalIndex, 0);
  assert.equal(r.decisions.length, 0);
  assert.equal(r.groundTruthAvailable, false);
  assert.deepEqual(r.verifiedIndices, [0]);
  assert.ok(r.alignmentMs.p95 >= 0);
});
