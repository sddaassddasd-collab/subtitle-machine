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
  assert.match(f.control().transcription.silenceTimeoutMessage, /1 分鐘/);
  assert.match(f.state().message, /切回手動/);
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 0);
});
