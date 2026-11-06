const {test} = require('node:test');
const assert = require('node:assert/strict');
const {TranscriptionHealth} = require('../src/transcription-health');
const createFixture = require('./helpers/audio-server-fixture');

test('packet lag accounts for client clock offset and exposes receive bursts, buffer size and server delays', () => {
  const h = new TranscriptionHealth(1000);
  assert.equal(h.receive({capturedAt: 100000, durationMs: 20}, 1000), 0);
  assert.equal(h.receive({capturedAt: 100020, durationMs: 20, captureAgeMs: 1400}, 3020), 2000);
  assert.equal(h.tick(1000, 2000), null);
  const report = h.tick(96001, 7000);
  assert.equal(report.maxNetworkAgeMs, 2000); assert.equal(report.maxCaptureAgeMs, 1400);
  assert.equal(report.receivedAudioMs, 40); assert.equal(report.maxEventLoopDelayMs, 4000);
  assert.equal(report.providerBufferedBytes, 96001); assert.ok(report.rssBytes > 0);
});
test('packets from a stopped capture cannot enter the replacement provider clock', t => {
  const f = createFixture({lineCount: 2}); t.after(() => f.dispose());
  f.stream.captureId = 'new';
  const result = f.send({sessionId: f.session.id, captureId: 'old', sequence: 1,
    audio: Buffer.alloc(960).toString('base64'), durationMs: 20});
  assert.equal(result.reason, 'old_capture'); assert.equal(f.stream.autoFollowAudioMs, 0);
  assert.equal(f.sent.length, 0);
});
test('expired capture audio stops with a recoverable status before it changes cue or provider time', t => {
  const f = createFixture({lineCount: 2}); t.after(() => f.dispose());
  f.stream.captureId = 'current';
  const result = f.send({sessionId: f.session.id, captureId: 'current', sequence: 1, captureAgeMs: 1800,
    audio: Buffer.alloc(960).toString('base64'), durationMs: 20});
  assert.equal(result.recoverable, true); assert.equal(f.stream.autoFollowAudioMs, 0);
  assert.equal(f.session.currentIndex, 0); assert.equal(f.session.transcription.recoverable, true);
});
