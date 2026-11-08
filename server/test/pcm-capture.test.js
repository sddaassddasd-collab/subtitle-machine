const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {registerPcmCapture} = require('../src/pcm-capture');
const {encodeAudioPacket} = require('../src/capture-wire.mjs');
const {LiveAudioTimeline} = require('../src/live-audio-timeline');
const createFixture = require('./helpers/audio-server-fixture');
const packet = (sequence, extra = {}) => ({sequence, captureId: 'capture', pcm: Buffer.alloc(1920), durationMs: 40, ...extra});

test('PCM receipts are cumulative and failures are immediate', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const socket = new EventEmitter(), receipts = [], received = [];
  socket.on('transcription:audio-ack', ack => receipts.push(ack));
  registerPcmCapture(socket, (data, ack) => {received.push(data); ack({ok: true});});
  socket.emit('transcription:audio-pcm', packet(1));
  socket.emit('transcription:audio-pcm', packet(2));
  socket.emit('transcription:audio-pcm', packet(3));
  assert.deepEqual(receipts.map(r => r.sequence), [1]);
  t.mock.timers.tick(100);
  assert.deepEqual(receipts.map(r => r.sequence), [1, 3]);
  assert.equal(receipts[1].receivedAt, 10000); assert.equal(receipts[1].acknowledgedAt, 10100);
  assert.equal(received[2].audio.byteLength, 1920);
  socket.emit('transcription:audio-pcm', packet(4, {durationMs: 1000}));
  assert.equal(receipts.at(-1).ok, false); assert.equal(receipts.at(-1).reason, 'invalid_pcm_packet');
  assert.equal(received.length, 3);
  socket.emit('disconnect');
});

test('closing an old PCM socket cannot leak a queued receipt into another capture', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const socket = new EventEmitter(), receipts = [];
  socket.on('transcription:audio-ack', ack => receipts.push(ack));
  registerPcmCapture(socket, (_data, ack) => ack({ok: true}));
  socket.emit('transcription:audio-pcm', packet(1)); socket.emit('transcription:audio-pcm', packet(2));
  socket.emit('disconnect'); t.mock.timers.tick(1000);
  assert.equal(receipts.length, 1);
});

test('packed audio uses the authenticated capture binding and stale epochs cannot enter a new stream', () => {
  const socket = new EventEmitter(), received = [];
  socket.data = {capture: {sessionId: 'show', captureId: 'new', sourceId: 'mic', captureGeneration: 12345}};
  registerPcmCapture(socket, (data, ack) => {received.push(data); ack({ok: true});});
  const pcm = Int16Array.from({length: 1920}, (_, i) => Math.round(655 * Math.sin(i * Math.PI / 65)));
  const payload = {pcm: pcm.buffer, sequence: 1, capturedAt: 10000, sourceEndMs: 80, captureAgeMs: 40};
  socket.emit('transcription:audio-packed', Buffer.from(encodeAudioPacket(payload, 12344)));
  assert.equal(received.length, 0);
  socket.emit('transcription:audio-packed', Buffer.from(encodeAudioPacket(payload, 12345)));
  assert.equal(received.length, 1); assert.equal(received[0].captureId, 'new'); assert.equal(received[0].sessionId, 'show');
  assert.equal(received[0].sourceId, 'mic'); assert.equal(received[0].durationMs, 80);
  assert.deepEqual(received[0].pcm, Buffer.from(pcm.buffer)); socket.emit('disconnect');
});

test('the real authorized packed handler preserves PCM and provider time without rebuilding the script', t => {
  const f = createFixture({lineCount: 1000}); t.after(() => f.dispose());
  Object.assign(f.stream, {captureId: 'packed', captureClock: 'audio-thread-v2', captureTimeline: new LiveAudioTimeline('mic')});
  const binding = {sessionId: f.session.id, captureId: 'packed', sourceId: 'mic', captureGeneration: 12345};
  f.send.socketData.capture = binding;
  const pcm = Int16Array.from({length: 1920}, (_, i) => Math.round(655 * Math.sin(i * Math.PI / 65)));
  const wire = Buffer.from(encodeAudioPacket({pcm: pcm.buffer, sequence: 1, capturedAt: Date.now(), sourceEndMs: 80}, 12345));
  f.event('transcription:audio-packed', wire);
  assert.equal(f.stream.autoFollowAudioMs, 80); assert.deepEqual(f.sent[0], Buffer.from(pcm.buffer));
  assert.deepEqual(f.counts(), {structures: 0, lines: 0});
  const stranger = f.connect('not-authorized'); stranger.socketData.capture = binding;
  stranger.event('transcription:audio-packed', wire);
  assert.equal(f.sent.length, 1);
});

test('real authenticated server handler forwards binary PCM without rebuilding the script or its clock', t => {
  const f = createFixture({lineCount: 1000}); t.after(() => f.dispose());
  const emitted = []; f.stream.captureId = 'capture';
  // The fixture executes the actual registered Socket.IO binary handler.
  f.event('transcription:audio-pcm', packet(1, {level: .1, capturedAt: Date.now(), captureAgeMs: 0}));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].length, 1920);
  assert.equal(f.stream.autoFollowAudioMs, 40);
  assert.deepEqual(f.counts(), {structures: 0, lines: 0});
  const stranger = f.connect('not-authorized');
  stranger.event('transcription:audio-pcm', packet(2));
  assert.equal(f.sent.length, 1);
  assert.equal(emitted.length, 0);
});

test('replacement starts atomically supersede the same controller and old starts/stops cannot terminate them', t => {
  const key = process.env.DEEPGRAM_API_KEY; process.env.DEEPGRAM_API_KEY = 'local-test-only';
  t.after(() => {if (key === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = key;});
  const f = createFixture({lineCount: 3}); t.after(() => f.dispose());
  f.allowSettings(); f.mockProviderStart(); f.history.start = async () => {};
  Object.assign(f.stream, {captureOwnerId: 'controller', captureGeneration: 1, captureId: 'old'});
  const replacement = f.connect(undefined, 'new-audio-socket');
  const options = {provider: 'deepgram', autoFollow: true, preserveTextOnRestart: true,
    clientInfo: {captureOwnerId: 'controller', captureGeneration: 2, captureId: 'new'}};
  assert.equal(replacement.event('transcription:start', options).ok, true);
  const current = f.currentStream(); assert.equal(current.captureId, 'new');
  assert.equal(f.send.event('transcription:start', {...options, clientInfo: {...options.clientInfo, captureGeneration: 1}}).reason, 'stale_capture_start');
  f.send.event('transcription:stop', {captureId: 'old'});
  f.send.event('disconnect');
  assert.equal(f.currentStream(), current); assert.equal(current.closing, false);
  const other = f.connect(undefined, 'another-controller');
  assert.equal(other.event('transcription:start', {...options, clientInfo: {...options.clientInfo, captureOwnerId: 'other'}}).ok, false);
});
