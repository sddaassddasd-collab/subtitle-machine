const {test} = require('node:test');
const assert = require('node:assert/strict');
const {TranscriptionHealth} = require('../src/transcription-health');
const createFixture = require('./helpers/audio-server-fixture');
test('the reported 1514 ms receive delay keeps the capture and provider clock running', t => {
  const f = createFixture({lineCount: 2}); t.after(() => f.dispose());
  let now = 100000; t.mock.method(Date, 'now', () => now);
  f.stream.captureId = 'current';
  const packet = (sequence, capturedAt) => ({sessionId: f.session.id, captureId: 'current', sequence, capturedAt,
    captureAgeMs: 4, audio: Buffer.alloc(960).toString('base64'), durationMs: 20});
  assert.equal(f.send(packet(1, 100000)).ok, true);
  now = 101534;
  assert.equal(f.send(packet(2, 100020)).ok, true);
  assert.equal(f.stream.closing, false); assert.equal(f.stream.autoFollowAudioMs, 40);
});
test('network recovery requires sustained serious lag; catching up resets the hold', () => {
  const h = new TranscriptionHealth(0);
  assert.equal(h.networkDecision(1514, 1000).stop, false);
  assert.equal(h.networkDecision(3500, 2000).stop, false);
  assert.equal(h.networkDecision(3500, 6500).stop, false);
  assert.equal(h.networkDecision(1500, 6800).stop, false);
  assert.equal(h.networkDecision(3500, 7000).stop, false);
  assert.equal(h.networkDecision(3500, 12000).stop, true);
  assert.equal(new TranscriptionHealth().networkDecision(10000).stop, true);
});

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
  assert.equal(result.recoveryReason, 'stale_capture');
  assert.equal(f.session.currentIndex, 0); assert.equal(f.session.transcription.recoverable, true);
});
test('the original capture owner can report recovery after stream removal, but another socket or epoch cannot', t => {
  const f = createFixture({lineCount: 2}); t.after(() => f.dispose());
  const events = []; f.history.event = (_id, type, data) => events.push({type, ...data});
  f.stream.captureId = 'current'; f.send.socketData.capture = {sessionId: f.session.id, captureId: 'current'};
  f.send({sessionId: f.session.id, captureId: 'current', sequence: 1, captureAgeMs: 1800,
    audio: Buffer.alloc(960).toString('base64'), durationMs: 20});
  f.event('transcription:health', {captureId: 'current', reason: 'recovery_scheduled', cause: 'stale_capture', attempt: 1});
  assert.equal(events.filter(e => e.reason === 'recovery_scheduled').length, 1);
  f.connect(undefined, 'another-socket').event('transcription:health', {captureId: 'current', reason: 'recovery_scheduled'});
  f.event('transcription:health', {captureId: 'old', reason: 'recovery_scheduled'});
  assert.equal(events.filter(e => e.reason === 'recovery_scheduled').length, 1);
});
