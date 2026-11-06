const {test} = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/audio-server-fixture');
const {normalizePerformanceSettings} = require('../src/performance-follow');
const {historyReport} = require('../src/auto-follow-history-report');
const texts = ['現在開始我們今天的演出', '這一段有很多人同時說話', '大家都有各自不同的意見', '最後大家終於安靜下來了', '請繼續聽我把故事說下去', '這就是今天故事的結局了'];
function setup(t, extra = {}) {
  const f = fixture({texts, allowCueChanges: true, ...extra}); t.after(() => f.dispose()); f.allowSettings();
  f.session.performanceFollowing = normalizePerformanceSettings({automaticLive: true});
  f.session.captionMode = 'script'; f.stream.liveTranslationStreamId = 's';
  f.session.transcription.active = true;
  const events = [], confirmations = [], visits = [];
  f.history.event = (id, type, data) => events.push({type, ...data});
  f.history.confirm = (id, index, source, data) => confirmations.push({index, source, ...data});
  f.history.enter = (s, index, data) => visits.push({index, ...data});
  const say = (text, id, startMs, endMs, receivedAt = endMs, extraOptions = {}) => {
    f.stream.autoFollowAudioMs = endMs;
    f.transcript(text, {itemId: id, streamId: 's', startMs, endMs, receivedAt, isFinal: true, ...extraOptions});
  };
  const begin = () => {
    say(texts[0], 'anchor', 0, 1000, 1000);
    say('今天突然想先跟大家聊一件事情', 'x', 1100, 3000, 3000);
    say('外面下著雨不曉得大家帶了傘沒有', 'y', 4000, 8000, 8000);
  };
  return {...f, events, confirmations, visits, say, begin};
}
test('automatic live keeps the stream, performance language, recording and script cursor while both displays change source', t => {
  const f = setup(t); f.session.activeRecordingId = null;
  f.begin();
  assert.equal(f.session.automaticLive, true);
  assert.equal(f.session.captionMode, 'script'); assert.equal(f.session.subtitleControlMode, 'auto');
  assert.equal(f.stream.closing, false); assert.equal(f.stream.ready, true); assert.equal(f.stream.socket.readyState, 1);
  assert.equal(f.session.currentIndex, 0); assert.equal(f.session.transcriptionLanguage, 'zh-TW');
  for (const out of [f.viewer(), f.projector()]) {
    assert.equal(out.source, 'transcription'); assert.match(out.text, /帶了傘/); assert.ok(!out.text.includes(texts[0]));
  }
  assert.equal(f.session.subtitleControlMode, 'auto', 'normalization must not turn automatic live into a discussion');
  assert.ok(f.events.some(e => e.action === 'source' && e.reason === 'sustained_unmatched_speech'));
  const stored = f.storage();
  assert.equal(stored.captionMode, 'script'); assert.equal(stored.projectorDisplayMode, 'script');
  assert.equal(stored.performanceFollowing.automaticLive, true); assert.equal(stored.automaticLive, undefined);
});
test('fresh distinctive script speech returns to a newly located cue rather than restoring the old cue', t => {
  const f = setup(t); f.begin();
  f.say(texts[3], 'return', 12000, 14000, 14000);
  assert.equal(f.session.automaticLive, false); assert.equal(f.session.currentIndex, 3);
  assert.equal(f.viewer().text, texts[3]); assert.equal(f.projector().text, texts[3]);
  assert.equal(f.state().lastDecision.source, 'script_return');
  assert.equal(f.state().armedIndex, null); assert.equal(f.follower().buffer.length, 0);
  assert.equal(f.stream.ready, true); assert.equal(f.session.transcriptionLanguage, 'zh-TW');
  assert.ok(f.confirmations.some(c => c.index === 3 && c.reason === 'script_reacquired' && c.completed === false));
});
test('locked live continues background location, then can return after unlock; locked script never starts improvised output', t => {
  const f = setup(t); f.begin();
  assert.equal(f.event('performance:action', {action: 'lock-live'}).ok, true);
  f.say(texts[3], 'a', 12000, 14000, 14000);
  assert.equal(f.session.automaticLive, true); assert.equal(f.session.currentIndex, 0);
  assert.equal(f.event('performance:action', {action: 'auto'}).ok, true);
  f.say(texts[4], 'b', 15000, 17000, Date.now() + 5000);
  assert.equal(f.session.automaticLive, false); assert.equal(f.session.currentIndex, 4);
  assert.equal(f.event('performance:action', {action: 'lock-script'}).ok, true);
  f.say('這是臨時加進來的一段話', 'c', 18000, 21000, 21000);
  f.say('還有一段劇本沒有寫的內容', 'd', 22000, 26000, 26000);
  assert.equal(f.session.automaticLive, false);
});
test('manual cue movement cancels automatic live without closing capture and fences old inference', t => {
  const f = setup(t); f.begin();
  f.event('setCurrentIndex', {index: 2});
  assert.equal(f.session.automaticLive, false); assert.equal(f.session.currentIndex, 2);
  assert.equal(f.follower().lock, 'script'); assert.equal(f.stream.ready, true); assert.equal(f.stream.closing, false);
  f.say(texts[0], 'old', 0, 1000, 15000);
  assert.equal(f.session.currentIndex, 2);
});
test('group pacing enters configured cues only, remains unconfirmed, and text can confirm the actual exit', t => {
  const f = setup(t);
  f.session.performanceFollowing = normalizePerformanceSettings({automaticLive: true, overlapGroups: [{id: 'g', cellId: f.session.selectedCellId,
    startLineId: 'line-1', endLineId: 'line-3', minimumSeconds: 1.8, maximumSeconds: 30}]});
  f.say(texts[1], 'entry', 0, 1000, 1000);
  assert.ok(f.state().performance.group);
  const p = f.follower();
  p.lastPacketAt = 2000; p.lastPacketAudioMs = 2000;
  const next = p.group.nextAudioMs; p.lastPacketAt = next - 20; p.lastPacketAudioMs = next - 20;
  f.tick(next, next);
  assert.equal(f.session.currentIndex, 2); assert.equal(f.state().lastDecision.source, 'paced_estimate');
  assert.ok(!f.confirmations.some(c => c.index === 2));
  assert.ok(f.visits.some(v => v.index === 2 && v.source === 'paced_estimate'));
  f.say(texts[4], 'exit', 10000, 12000, 12000);
  assert.equal(f.session.currentIndex, 4); assert.equal(f.state().performance.group, null);
  assert.ok(f.events.some(e => e.reason === 'overlap_exit_recognized'));
});
test('settings and controls reject another controller, unauthenticated clients, invalid ranges and unsupported actions', t => {
  const f = setup(t);
  const settings = {automaticLive: true, overlapGroups: [{id: 'g', cellId: f.session.selectedCellId,
    startLineId: 'line-1', endLineId: 'line-3'}]};
  assert.equal(f.event('performance:set-settings', {settings}).ok, true);
  assert.equal(f.event('performance:set-settings', {settings: {...settings, overlapGroups: [{...settings.overlapGroups[0], endLineId: 'line-5'}]}}).ok, false);
  assert.equal(f.event('performance:action', {action: 'unknown'}).ok, false);
  assert.equal(f.connect(undefined, 'different-controller').event('performance:action', {action: 'lock-live'}).ok, false);
  assert.equal(f.connect(undefined, 'different-controller').event('performance:set-settings', {settings}).ok, false);
  assert.equal(f.connect('bad-cookie', 'anonymous').event('performance:action', {action: 'lock-live'}).ok, false);
  assert.equal(f.session.automaticLive, undefined);
});
test('provider reconnect uses a fresh audio clock and can reacquire without leaving auto mode', t => {
  const f = setup(t); f.begin();
  f.restartTracking(); f.stream.autoFollowAudioMs = 0;
  assert.equal(f.state().performance.source, 'live');
  f.say(texts[3], 'after-reconnect', 0, 1500, Date.now() + 5000);
  assert.equal(f.session.currentIndex, 3); assert.equal(f.session.automaticLive, false);
});
test('pausing capture stops overlap immediately; no elapsed timer can move another cue', t => {
  const f = setup(t);
  f.session.performanceFollowing = normalizePerformanceSettings({overlapGroups: [{id: 'g', cellId: f.session.selectedCellId,
    startLineId: 'line-1', endLineId: 'line-3'}]});
  f.say(texts[1], 'entry', 0, 1000);
  f.event('transcription:stop', {});
  assert.equal(f.follower().group, null); f.tick(10000, 10000);
  assert.equal(f.session.currentIndex, 1);
});
test('history labels estimated visits separately and never counts them as confirmed speech', () => {
  const events = [
    {type: 'context', contextId: 'c', lines: texts.map((text, index) => ({id: `l${index}`, text, index}))},
    {type: 'cue_enter', contextId: 'c', visitId: 'v', index: 1, source: 'paced_estimate', at: 2000},
  ];
  const report = historyReport({run: {startedAt: 0}, events});
  assert.equal(report.rows[1].status, 'estimated'); assert.equal(report.rows[1].confirmedCount, 0);
});

test('a retained script prefix in a growing ASR item cannot bring live output back to an old cue', t => {
  const f = setup(t); f.begin();
  const text = texts[0] + '這是演員突然即興插入的新發言';
  f.say(text, 'anchor', 0, 14000, 14000, {words: [
    {word: texts[0], start: 0, end: 1}, {word: '這是演員突然即興插入的新發言', start: 12, end: 14}]});
  assert.equal(f.session.automaticLive, true); assert.equal(f.session.currentIndex, 0);
  assert.ok(!f.viewer().text.includes(texts[0]));
});

test('independently supported semantic paraphrases can return from live without stopping capture or inventing completion', async t => {
  const f = setup(t); f.begin();
  let index = 1;
  f.enableSemantic(async () => ({choices: [{message: {content: JSON.stringify({index, confidence: .96})}}]}));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  f.say('我認為可以提出另一個想法', 'semantic-a', 12000, 14000, 14000); await flush();
  assert.equal(f.session.automaticLive, true);
  assert.equal(f.state().performance.preparedIndex, 1);
  index = 2;
  f.say('不過每個人的看法都未必相同', 'semantic-b', 15000, 17000, 17000); await flush();
  assert.equal(f.session.automaticLive, false); assert.equal(f.session.currentIndex, 2);
  assert.equal(f.state().lastDecision.source, 'script_return');
  assert.equal(f.state().lastDecision.supportSource, 'semantic');
  assert.ok(!f.confirmations.some(c => c.index === 2));
  assert.equal(f.state().armedIndex, null); assert.equal(f.stream.ready, true);
});

test('automatic live can be explicitly returned to script after capture is paused', t => {
  const f = setup(t); f.begin(); f.event('transcription:stop', {preserveText: true});
  assert.equal(f.session.automaticLive, true);
  assert.equal(f.event('performance:action', {action: 'lock-script'}).ok, true);
  assert.equal(f.session.automaticLive, false); assert.equal(f.viewer().source, 'script');
});

test('editing an overlap cue invalidates the running pace and deleted anchors do not attach to another cue', t => {
  const f = setup(t);
  f.session.performanceFollowing = normalizePerformanceSettings({overlapGroups: [{id: 'g', cellId: f.session.selectedCellId,
    startLineId: 'line-1', endLineId: 'line-3'}]});
  f.say(texts[1], 'entry', 0, 1000); assert.ok(f.follower().group);
  f.session.lines[2].text = '劇本內容已經修改';
  assert.equal(f.follower().group, null);
  f.session.lines = f.session.lines.filter(l => l.id !== 'line-1');
  f.session.sharedLines = f.session.lines;
  const p = f.follower(); assert.equal(p.groups[0].valid, false);
  assert.throws(() => p.command('start-overlap', 1, 1000), /有效交疊段/);
});
