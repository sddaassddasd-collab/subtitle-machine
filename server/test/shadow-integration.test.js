const {test} = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/audio-server-fixture');
const texts = ['目前這句已經完整說完了', '你準備好了嗎我們一起出發', '請你跟著我走向明天的道路'];
const flush = async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));};
function setup(t) {
  const f = fixture({texts, allowCueChanges: true}); t.after(() => f.dispose());
  const reports = []; f.history.event = (id, type, data) => {if (type === 'tracking_comparison') reports.push(data);};
  const say = (text, id, startMs, endMs, extra = {}) => {
    f.stream.autoFollowAudioMs = endMs;
    f.transcript(text, {itemId: id, streamId: 's', startMs, endMs, receivedAt: endMs, isFinal: true, ...extra});
  };
  return {...f, reports, say};
}
test('server publishes cues immediately and later records an independent comparison for the same revision', async t => {
  const f = setup(t); f.say(texts[0], 'anchor', 0, 1000);
  assert.equal(f.reports.length, 0); await flush();
  assert.equal(f.reports[0].locator.confirmedIndex, 0);
  f.say('你', 'opening', 1100, 1200);
  assert.equal(f.session.currentIndex, 1);
  const viewer = structuredClone(f.viewer()), projector = structuredClone(f.projector());
  await flush();
  assert.equal(f.shadow().index, 0);
  assert.equal(f.reports.at(-1).relationship, 'awaiting_confirmation');
  assert.equal(f.reports.at(-1).itemId, 'opening');
  assert.equal(f.reports.at(-1).audioEndMs, 1200);
  assert.ok(f.reports.at(-1).revisionId);
  assert.deepEqual(f.viewer(), viewer); assert.deepEqual(f.projector(), projector);
  assert.notEqual(f.tracker(), f.shadow().tracker);
  f.say(texts[1], 'confirmed', 1300, 2500); await flush();
  assert.equal(f.reports.at(-1).relationship, 'aligned');
  assert.equal(f.reports.at(-1).locator.index, 1);
});
test('manual reposition cancels queued old tracking and seeds a new independent origin', async t => {
  const f = setup(t); f.say(texts[0], 'old', 0, 1000);
  const old = f.shadow(); f.event('setCurrentIndex', {index: 2});
  assert.notEqual(f.shadow(), old); assert.equal(old.closed, true);
  await flush(); assert.equal(f.reports.length, 0);
  f.say(texts[2], 'manual-new', 2000, 3000); await flush();
  assert.equal(f.reports.at(-1).locator.index, 2);
  assert.equal(f.reports.at(-1).resetReason, 'initial');
});
test('provider tracking restart preserves independent position rather than the displayed preview', async t => {
  const f = setup(t); f.say(texts[0], 'a', 0, 1000); await flush();
  f.say('你', 'preview', 1100, 1200); await flush();
  assert.equal(f.session.currentIndex, 1); assert.equal(f.shadow().index, 0);
  f.restartTracking();
  f.say(texts[0], 'after-restart', 0, 1000, {streamId: 'new-provider'}); await flush();
  assert.equal(f.reports.at(-1).locator.index, 0);
});
test('wrong provider or language cannot enter the independent tracking queue', async t => {
  const f = setup(t); f.stream.liveTranslationStreamId = 's';
  f.say(texts[0], 'wrong-provider', 0, 1000, {streamId: 'other'});
  f.say(texts[0], 'wrong-language', 0, 1000, {language: 'en'});
  await flush(); assert.equal(f.reports.length, 0);
});
test('diagnostic recording failure cannot alter cue output or escape the handler', async t => {
  const f = setup(t); f.shadow().record = () => {throw Error('history unavailable');};
  f.say(texts[0], 'a', 0, 1000); f.say('你', 'preview', 1100, 1200);
  assert.equal(f.session.currentIndex, 1); await flush();
  assert.equal(f.session.currentIndex, 1); assert.equal(f.shadow().index, 0);
});
