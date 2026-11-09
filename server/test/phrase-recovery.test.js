const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTracker, followTranscript, prepareScript} = require('../src/auto-follow');
const {phraseRecovery} = require('../src/phrase-recovery');
const fixtures = require('./fixtures/phrase-rehearsal.json');

for (const f of fixtures) test(`recorded paraphrase restores ${f.name} without preparing another guess`, () => {
  const tracker = createTracker(); let current = 0, result;
  for (const e of f.events) {
    result = followTranscript(tracker, f.lines, current,
      {...e, streamId: 's', startMs: e.audioStartMs, endMs: e.audioEndMs});
    if (Number.isInteger(result.index)) current = result.index;
  }
  assert.equal(current, f.name === 'merchant' ? 3 : 2);
  assert.equal(result.reason, 'nearby_phrase_recovery');
  assert.equal(result.completed, false);
  assert.deepEqual(result.spans, []);
  assert.equal(tracker.openingPlan, null);
  assert.equal(tracker.preparedIndex, null);
  assert.equal(result.evidence.startMs, f.events.at(-1).audioStartMs);
  assert.equal(result.evidence.endMs, f.events.at(-1).audioEndMs);
  const next = followTranscript(tracker, f.lines, current,
    {streamId: 's', itemId: 'unproved', text: '啊', startMs: result.evidence.endMs + 100, endMs: result.evidence.endMs + 300});
  assert.equal(next.index, undefined, 'location recovery must not start a chain of blind predictions');
});

for (const mode of ['interim', 'no-words', 'expired', 'old-audio', 'negation', 'ambiguous', 'music', 'direction', 'distant', 'backward', 'reversed']) {
  test(`phrase recovery rejects ${mode}`, () => {
    const f = fixtures[0], last = f.events.at(-1);
    let lines = f.lines.map(l => ({...l}));
    const tracker = {textAnchor: {index: 0, atMs: 957220}, prediction: {onsetMs: 957380}};
    const event = {...last, startMs: last.audioStartMs, endMs: last.audioEndMs};
    if (mode === 'interim') event.isFinal = false;
    if (mode === 'no-words') event.words = [];
    if (mode === 'expired') tracker.textAnchor.atMs = 0;
    if (mode === 'old-audio') tracker.textAnchor.atMs = event.endMs;
    if (mode === 'negation') lines[3].text = '請國王大人不要直接帶歌手來我家';
    if (mode === 'ambiguous') lines[2].text = lines[3].text;
    if (mode === 'music') lines[2].music = true;
    if (mode === 'direction') lines[2].type = 'direction';
    if (mode === 'distant') lines.splice(2, 0, ...Array.from({length: 4}, () => ({text: '遠處的不同台詞'})));
    if (mode === 'backward') {lines[0].text = lines[3].text; lines[3].text = '這是不相干的其他台詞';}
    if (mode === 'reversed') {
      event.text = '來我家歌手國王大人';
      event.words = [{word: event.text, startMs: event.startMs, endMs: event.endMs}];
    }
    assert.equal(phraseRecovery(tracker, prepareScript(lines), 1, event), null);
  });
}
