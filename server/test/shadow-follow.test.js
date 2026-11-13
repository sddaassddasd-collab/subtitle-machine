const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ShadowFollow, SHADOW_FOLLOW_SETTINGS} = require('../src/shadow-follow');
const {createTracker, followTranscript} = require('../src/auto-follow');
const texts = ['目前這句已經完整說完了', '你準備好了嗎我們一起出發', '請你跟著我走向明天的道路'];
const lines = texts.map(text => ({text}));
function setup() {
  const jobs = [], reports = []; let time = 1000;
  const shadow = new ShadowFollow({record: data => reports.push(data),
    schedule: cb => {const job = {cb}; jobs.push(job); return job;},
    cancel: job => {job.cb = null;}, now: () => time++});
  const push = (text, itemId, startMs, endMs, extra = {}) => shadow.enqueue({lines, seedIndex: 0, streamId: 'capture',
    event: {text, itemId, streamId: 'provider', startMs, endMs, receivedAt: time, revisionId: itemId, isFinal: true},
    display: {index: 0, source: 'script'}, ...extra});
  const flush = () => {while (jobs.length) {const job = jobs.shift(); job.cb?.();}};
  return {shadow, reports, push, flush};
}
test('shadow is deferred, owns its cursor and does not follow an unconfirmed cue display', () => {
  const f = setup();
  f.push(texts[0], 'a', 0, 1000); assert.equal(f.shadow.index, undefined);
  f.flush(); assert.equal(f.shadow.index, 0); assert.equal(f.shadow.confirmedIndex, 0);
  f.push('你', 'b', 1100, 1200, {seedIndex: 2, display: {index: 1, source: 'script', predicted: true}});
  f.flush();
  assert.equal(f.shadow.index, 0);
  assert.equal(f.reports.at(-1).relationship, 'awaiting_confirmation');
  f.push(texts[1], 'c', 1300, 2500, {seedIndex: 2, display: {index: 1, source: 'script', predicted: true}});
  f.flush(); assert.equal(f.shadow.index, 1); assert.equal(f.reports.at(-1).relationship, 'aligned');
  assert.equal(f.reports.at(-1).independentEvidence, false);
  assert.equal(f.reports.at(-1).mode, 'observe_only');
});
test('normal one-cue preview is labelled awaiting confirmation, not an automatic correction', () => {
  const f = setup();
  f.push(texts[0], 'a', 0, 1000, {display: {index: 1, source: 'script', predicted: true}});
  f.flush(); assert.equal(f.reports[0].relationship, 'awaiting_confirmation');
  assert.equal(f.reports[0].requiresReview, false);
});
test('comparison retains the display snapshot and word data from the same revision', () => {
  const f = setup(), display = {index: 0, source: 'script'};
  const event = {text: texts[0], itemId: 'a', streamId: 'provider', startMs: 0, endMs: 1000, isFinal: true,
    words: [{word: texts[0], startMs: 0, endMs: 1000}], revisionId: 'r', receivedAt: 1234};
  f.shadow.enqueue({lines, event, display, seedIndex: 0, streamId: 'capture'});
  display.index = 2; event.text = '別的文字'; event.words[0].word = '別的文字';
  f.flush(); assert.equal(f.reports[0].display.index, 0);
  assert.equal(f.reports[0].revisionId, 'r'); assert.equal(f.reports[0].at, 1234);
  assert.equal(f.shadow.index, 0); assert.equal(f.reports[0].audioEndMs, 1000);
});
for (const [name, display] of [['live_output', {index: 2, source: 'live'}],
  ['display_hidden', {index: 2, source: 'script', hidden: true}],
  ['caption_handoff', {index: 2, source: 'script', holding: true}]]) {
  test(`${name} does not count as a cue mismatch`, () => {
    const f = setup(); f.push(texts[0], 'a', 0, 1000, {display}); f.flush();
    assert.equal(f.reports[0].relationship, name); assert.equal(f.reports[0].requiresReview, false);
  });
}
test('provider restart preserves independent position and starts a new audio clock', () => {
  const f = setup(); f.push(texts[1], 'a', 10000, 12000); f.flush(); assert.equal(f.shadow.index, 1);
  f.push(texts[1], 'new', 0, 1000, {seedIndex: 2,
    event: {text: texts[1], itemId: 'new', streamId: 'new-provider', startMs: 0, endMs: 1000, isFinal: true}});
  f.flush(); assert.equal(f.shadow.index, 1); assert.equal(f.reports.at(-1).resetReason, 'provider_stream_changed');
});
test('audio gap invalidates old evidence without adopting the displayed guess', () => {
  const f = setup(); f.push(texts[0], 'a', 0, 1000); f.flush();
  f.push(texts[0], 'b', 1100, 1200, {seedIndex: 2, gapFenceMs: 1500}); f.flush();
  assert.equal(f.shadow.index, 0); assert.equal(f.reports.at(-1).resetReason, 'audio_gap');
  assert.equal(f.reports.at(-1).locator.reason, 'before_manual_fence');
});
test('overload bounds the queue and explicitly resets stale evidence', () => {
  const f = setup();
  for (let i = 0; i < 80; i++) f.push(texts[0], `a${i}`, i * 1000, i * 1000 + 500);
  assert.equal(f.shadow.queue.length, SHADOW_FOLLOW_SETTINGS.maximumQueue);
  f.flush(); assert.equal(f.reports[0].droppedRevisions, 16);
  assert.equal(f.reports[0].resetReason, 'queue_overflow');
});
test('disposing pending work cancels old comparisons; recording failure is isolated', () => {
  const f = setup(); f.push(texts[0], 'a', 0, 1000); f.shadow.dispose(); f.flush();
  assert.equal(f.reports.length, 0);
  const g = setup(); g.shadow.record = () => {throw Error('storage failure');};
  g.push(texts[0], 'a', 0, 1000); assert.doesNotThrow(g.flush);
  assert.equal(g.shadow.index, 0);
});
test('cue results are identical whether independent shadow tracking is enabled or absent', () => {
  const a = createTracker(), b = createTracker(), f = setup(); let ca = 0, cb = 0;
  for (const [i, text] of [texts[0], '你', texts[1], texts[2]].entries()) {
    const event = {text, itemId: `a${i}`, streamId: 'provider', startMs: i * 1500, endMs: i * 1500 + 1000, isFinal: true};
    const ra = followTranscript(a, lines, ca, event), rb = followTranscript(b, lines, cb, event);
    assert.deepEqual(rb, ra);
    if (Number.isInteger(ra.index)) ca = ra.index;
    if (Number.isInteger(rb.index)) cb = rb.index;
    f.push(text, event.itemId, event.startMs, event.endMs, {display: {index: cb, source: 'script'}}); f.flush();
    assert.deepEqual(b, a);
  }
});

test('script edits reset analysis and retain distinct script signatures per queued revision', () => {
  const f = setup(); f.push(texts[0], 'before-edit', 0, 1000);
  const edited = lines.map(l => ({...l})); edited[0].text = '這是已經修改過的第一句台詞';
  f.push(texts[2], 'after-edit', 2000, 3000, {lines: edited, seedIndex: 2}); f.flush();
  assert.notEqual(f.reports[0].scriptSignature, f.reports[1].scriptSignature);
  assert.equal(f.reports[1].resetReason, 'script_changed');
  assert.equal(f.shadow.index, 2);
});
test('locator failures produce a comparison error and subsequent jobs can restart', () => {
  const f = setup(), analyze = f.shadow.analyze;
  f.shadow.analyze = () => {throw Error('test locator failure');};
  f.push(texts[0], 'a', 0, 1000); f.flush();
  assert.equal(f.reports[0].relationship, 'shadow_error');
  f.shadow.analyze = analyze; f.push(texts[0], 'b', 1100, 2200); f.flush();
  assert.equal(f.reports.at(-1).relationship, 'aligned');
});
