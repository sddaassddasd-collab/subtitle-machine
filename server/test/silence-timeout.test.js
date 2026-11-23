const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalizeSilenceTimeout, reachedSilenceTimeout} = require('../src/silence-timeout');
const createFixture = require('./helpers/audio-server-fixture');

test('silence counts audio time and resets on sound, lost packets, or a capture gap', () => {
  const settings = normalizeSilenceTimeout({enabled: true, minutes: 1});
  const stream = {};
  let at = 0, sequence = 0;
  const packet = (overrides = {}) => reachedSilenceTimeout(stream, settings,
    {quiet: true, durationMs: 100, at: at += 100, sequence: ++sequence, ...overrides});
  for (let i = 0; i < 599; i++) assert.equal(packet(), false);
  assert.equal(packet({quiet: false}), false);
  assert.equal(stream.silenceWindow.elapsedMs, 0);
  packet();
  sequence++;
  packet();
  assert.equal(stream.silenceWindow.elapsedMs, 100);
  at += 5000;
  packet();
  assert.equal(stream.silenceWindow.elapsedMs, 100);
  packet({gap: true});
  assert.equal(stream.silenceWindow.elapsedMs, 100);
  for (let i = 0; i < 598; i++) assert.equal(packet(), false);
  assert.equal(packet(), true);
});

test('the real audio handler persists manual mode and closes the provider without moving the cue', t => {
  const f = createFixture({lineCount: 2});
  t.after(() => f.dispose());
  f.allowSettings();
  assert.deepEqual(f.control().silenceTimeout, {enabled: false, minutes: 5});
  f.event('setSilenceTimeout', {enabled: true, minutes: 1});
  assert.deepEqual(f.storage().silenceTimeout, {enabled: true, minutes: 1});
  f.session.currentIndex = 1;
  f.stream.captureTimeline = {sourceId: 'blackhole'};
  f.stream.captureOwnerId = 'operator';
  f.stream.silenceWindow = {at: Date.now(), elapsedMs: 59980, sequence: 1};
  const ack = f.send({sessionId: f.session.id, sequence: 2, durationMs: 20, level: 0,
    audio: Buffer.alloc(960).toString('base64')});
  assert.equal(ack.reason, 'silence_timeout');
  assert.equal(f.storage().subtitleControlMode, 'manual');
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.currentStream(), undefined);
  assert.equal(f.stream.closing, true);
  assert.match(f.control().transcription.autoCaptureStopMessage, /1 分鐘/);
  assert.match(f.state().message, /切回手動/);
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 0);
});

test('a confirmed final dialogue stops capture after three seconds, with a trailing stage direction', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = createFixture({allowCueChanges: true, texts: ['我們準備開始演出', '感謝各位今晚的蒞臨',
    {text: '（熄燈）', type: 'direction'}]});
  t.after(() => f.dispose());
  f.allowSettings();
  assert.equal(f.control().stopAtScriptEnd, false);
  assert.deepEqual(f.event('setScriptEndStop', {enabled: true}), {ok: true});
  assert.equal(f.storage().stopAtScriptEnd, true);
  const say = (text, itemId, startMs, isFinal) => f.transcript(text, {itemId, startMs,
    endMs: startMs + 800, streamId: 'script-end', isFinal});
  say('我們準備開始演出', 'start', 0, true);
  assert.equal(f.stream.scriptEndTimer, undefined);
  say('感謝', 'end', 1000, false);
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.stream.scriptEndTimer, undefined);
  say('感謝各位今晚的蒞臨', 'end', 1000, true);
  assert.ok(f.stream.scriptEndTimer);
  t.mock.timers.tick(2999);
  assert.equal(f.currentStream(), f.stream);
  t.mock.timers.tick(1);
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.storage().subtitleControlMode, 'manual');
  assert.equal(f.currentStream(), undefined);
  assert.match(f.state().message, /劇本結尾/);
});

test('an explicit closing phrase can finish a mixed final cue and cue movement cancels a pending stop', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = createFixture({allowCueChanges: true, texts: ['我們準備開始演出',
    '最後那顆蛋破殼而出。燈光收。劇終。']});
  t.after(() => f.dispose());
  f.allowSettings();
  assert.equal(f.event('setScriptEndStop', {phrase: '好'}).ok, false);
  f.event('setScriptEndStop', {enabled: true, phrase: '破殼而出'});
  assert.equal(f.storage().scriptEndPhrase, '破殼而出');
  const say = (text, itemId, startMs) => f.transcript(text, {itemId, startMs,
    endMs: startMs + 800, streamId: 'script-end-phrase', isFinal: true});
  say('我們準備開始演出', 'start', 0);
  say('最後那顆蛋破殼而出', 'end', 1000);
  assert.equal(f.session.currentIndex, 1);
  assert.ok(f.stream.scriptEndTimer);
  f.event('setCurrentIndex', {index: 0});
  t.mock.timers.tick(3000);
  assert.equal(f.currentStream(), f.stream);
  assert.equal(f.session.subtitleControlMode, 'auto');
});
