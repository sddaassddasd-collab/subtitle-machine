const {test} = require('node:test');
const assert = require('node:assert/strict');
const createFixture = require('./helpers/audio-server-fixture');

test('manual takeover keeps capture and compares late text without moving the operator cue', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['我們準備開始演出', '請先放下你手中的東西', '感謝各位今晚的蒞臨']});
  t.after(() => f.dispose());
  f.allowSettings();
  f.stream.captureTimeline = {sourceId: 'mic-a'};
  const events = [], revisions = [];
  f.history.event = (_sessionId, type, data) => events.push({type, ...data});
  f.history.revision = (_sessionId, text, options, data) => revisions.push({text, options, data});
  const shadow = f.shadow();
  f.event('setKeepBackgroundFollow', {enabled: true});
  const monitor = f.connect(undefined, 'monitor');
  monitor.event('setSubtitleControlMode', {mode: 'manual'});
  assert.equal(f.session.subtitleControlMode, 'manual');
  assert.equal(f.currentStream(), f.stream);
  assert.equal(f.control().transcription.backgroundFollow, true);
  assert.equal(f.storage().manualBackgroundSourceId, 'mic-a');
  assert.equal(f.shadow(), shadow);
  assert.ok(events.some(event => event.type === 'control_mode' && event.backgroundFollow && event.index === 0));
  monitor.event('setCurrentIndex', {index: 1});
  const manualAt = f.session.manualBackgroundCueAt;
  const transcript = (text, itemId, startMs, receivedAt) => f.transcript(text,
    {streamId: 'script-input', itemId, startMs, endMs: startMs + 1000, receivedAt, isFinal: true});
  transcript('請先放下你手中的東西', 'late-line', 0, manualAt + 400);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revisions.at(-1).data.reason, 'manual_background_follow');
  const match = events.find(event => event.type === 'tracking_comparison' && event.locator.accepted);
  assert.equal(match.locator.index, 1);
  assert.equal(match.display.manualBackground, true);
  assert.equal(match.delayFromManualMs, 400);
  transcript('感謝各位今晚的蒞臨', 'ahead', 1200, manualAt + 1800);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.filter(event => event.type === 'tracking_comparison').at(-1).locator.index, 2);
  assert.equal(f.session.currentIndex, 1);
  monitor.event('transcription:stop-background');
  assert.equal(f.currentStream(), undefined);
  assert.equal(f.control().transcription.backgroundFollow, false);
});

test('a worker reconnect preserves manual control, and resuming auto reuses the open stream', t => {
  const key = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = 'local-test-only';
  t.after(() => {if (key === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = key;});
  const f = createFixture({lineCount: 3});
  t.after(() => f.dispose());
  f.allowSettings(); f.mockProviderStart(); f.history.start = async () => {};
  Object.assign(f.stream, {captureTimeline: {sourceId: 'mic'}, captureOwnerId: 'operator', captureGeneration: 1, captureId: 'old'});
  f.event('setKeepBackgroundFollow', {enabled: true});
  f.event('setSubtitleControlMode', {mode: 'manual'});
  const monitor = f.connect(undefined, 'monitor');
  const replacement = f.connect(undefined, 'replacement');
  assert.equal(replacement.event('transcription:start', {provider: 'deepgram', autoFollow: true, preserveTextOnRestart: true,
    clientInfo: {sourceId: 'mic', captureOwnerId: 'operator', captureGeneration: 2, captureId: 'new'}}).ok, true);
  const current = f.currentStream();
  assert.equal(current.manualBackgroundFollow, true);
  assert.equal(f.session.subtitleControlMode, 'manual');
  assert.equal(f.session.captionMode, 'script');
  monitor.event('setSubtitleControlMode', {mode: 'auto'});
  assert.equal(f.currentStream(), current);
  assert.equal(current.manualBackgroundFollow, false);
  assert.equal(f.session.subtitleControlMode, 'auto');
  assert.equal(f.storage().manualBackgroundSourceId, '');
  f.event('setKeepBackgroundFollow', {enabled: false});
  monitor.event('setSubtitleControlMode', {mode: 'manual'});
  assert.equal(f.currentStream(), undefined);
});

test('clicking a cue in auto leaves capture active and preserves background evidence from before the click', async t => {
  const f = createFixture({allowCueChanges: true, texts: ['我們準備開始演出', '請先放下你手中的東西']});
  t.after(() => f.dispose());
  const events = [], revisions = [];
  f.history.event = (_id, type, data) => events.push({type, ...data});
  f.history.revision = (_id, _text, _options, data) => revisions.push(data);
  const shadow = f.shadow();
  f.stream.autoFollowAudioMs = 2000;
  f.connect(undefined, 'monitor').event('setCurrentIndex', {index: 1});
  assert.equal(f.currentStream(), f.stream);
  assert.equal(f.session.subtitleControlMode, 'auto');
  assert.equal(f.shadow(), shadow);
  const receivedAt = Date.now() + 300;
  f.transcript('請先放下你手中的東西', {streamId: 'script', itemId: 'late', startMs: 1000,
    endMs: 1900, receivedAt, isFinal: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revisions.at(-1).reason, 'before_manual_fence');
  const comparison = events.find(event => event.type === 'tracking_comparison');
  assert.equal(comparison.locator.accepted, true);
  assert.equal(comparison.locator.index, 1);
  assert.equal(comparison.display.manualBackground, true);
  assert.equal(comparison.delayFromManualMs, receivedAt - comparison.display.manualCueAt);
  assert.equal(f.session.currentIndex, 1);
});
