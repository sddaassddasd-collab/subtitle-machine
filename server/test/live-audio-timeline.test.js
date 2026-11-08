const {test} = require('node:test');
const assert = require('node:assert/strict');
const {LiveAudioTimeline} = require('../src/live-audio-timeline');
const createFixture = require('./helpers/audio-server-fixture');

test('source gaps never become fictitious PCM duration and contiguous ranges remain compact', () => {
  const timeline = new LiveAudioTimeline('mic');
  for (let i = 0; i < 10000; i++) timeline.accept({sourceId: 'mic', sourceStartMs: i * 40,
    sourceEndMs: i * 40 + 40, durationMs: 40}, i * 40);
  assert.equal(timeline.ranges.length, 1); timeline.drop(400);
  const gap = timeline.accept({sourceId: 'mic', sourceStartMs: 401000, sourceEndMs: 401040, durationMs: 40}, 400000);
  assert.equal(gap.gapMs, 1000); assert.equal(timeline.providerMs, 400040)
  assert.equal(timeline.sourceTime(400000), 401000); assert.equal(timeline.sourceTime(400020), 401020)
  assert.equal(timeline.sourceTime(400041), null)
  assert.equal(timeline.accept({sourceId: 'other', sourceStartMs: 1, sourceEndMs: 41, durationMs: 40}, 0), null)
});

test('new capture protocol drops expired input without stopping the source or provider, fences old text and keeps the displayed cue', t => {
  const f = createFixture({lineCount: 30}); t.after(() => f.dispose());
  Object.assign(f.stream, {captureId: 'current', captureClock: 'audio-thread-v2', captureTimeline: new LiveAudioTimeline('mic')});
  f.session.currentIndex = 4;
  const events = []; f.history.event = (_id, type, data) => events.push({type, ...data});
  const packet = (sequence, sourceStartMs, captureAgeMs = 0) => ({sessionId: f.session.id, captureId: 'current',
    sourceId: 'mic', sourceStartMs, sourceEndMs: sourceStartMs + 40, sequence,
    audio: Buffer.alloc(1920).toString('base64'), durationMs: 40, level: .001, captureAgeMs});
  assert.equal(f.send(packet(1, 0)).ok, true)
  const old = f.send(packet(2, 40, 1800)); assert.equal(old.ok, true); assert.equal(old.dropped, true)
  assert.equal(f.stream.autoFollowAudioMs, 40); assert.equal(f.stream.closing, false)
  f.stream.draftByItemId.set('old-draft', '缺口之前的暫定字幕');
  assert.equal(f.send(packet(3, 1000)).ok, true)
  assert.equal(f.stream.autoFollowAudioMs, 80); assert.equal(f.session.currentIndex, 4)
  assert.equal(f.stream.captureGapFenceMs, 40)
  assert.equal(f.stream.draftByItemId.size, 0)
  assert.equal(events.filter(e => e.type === 'audio_gap').length, 1)
  assert.equal(events.find(e => e.type === 'audio_gap').gapMs, 960)
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 2)
  assert.ok(f.sent.some(data => typeof data === 'string' && JSON.parse(data).type === 'Finalize'))
  assert.equal(f.state().preparedIndex, null)
  f.transcript(f.session.lines[10].text, {itemId: 'late-before-gap', startMs: 0, endMs: 39, isFinal: true})
  assert.equal(f.session.currentIndex, 4)
  const probe = f.event('transcription:capture-probe', {captureId: 'current'})
  assert.equal(probe.ok, true); assert.equal(probe.sequence, 3); assert.equal(probe.serverAudioMs, 80)
  assert.equal(f.connect(undefined, 'stranger').event('transcription:capture-probe', {captureId: 'current'}).ok, false)
});

test('the associated control connection can operate the follower while an independent worker owns audio', t => {
  const f = createFixture({lineCount: 3}); t.after(() => f.dispose());
  f.stream.controlSocketId = 'controller';
  const controller = f.connect(undefined, 'controller');
  assert.equal(controller.event('performance:action', {action: 'lock-script'}).ok, true);
  assert.equal(f.connect(undefined, 'another-controller').event('performance:action', {action: 'lock-script'}).ok, false);
});

test('the reported receive lag does not discard ordered audio or restart recognition', t => {
  const f = createFixture({lineCount: 3}); t.after(() => f.dispose());
  let now = 100000; t.mock.method(Date, 'now', () => now);
  Object.assign(f.stream, {captureId: 'current', captureClock: 'audio-thread-v2', captureTimeline: new LiveAudioTimeline('mic')});
  const send = (sequence, sourceStartMs, capturedAt) => f.send({sessionId: f.session.id, captureId: 'current', sourceId: 'mic',
    sourceStartMs, sourceEndMs: sourceStartMs + 40, sequence, capturedAt, captureAgeMs: 0,
    audio: Buffer.alloc(1920).toString('base64'), durationMs: 40, level: .001});
  assert.equal(send(1, 0, 100000).ok, true);
  now = 103040; assert.equal(send(2, 40, 100040).dropped, undefined);
  assert.equal(f.stream.closing, false); assert.equal(f.stream.autoFollowAudioMs, 80);
  now = 103080; assert.equal(send(3, 3080, 103080).ok, true);
  assert.equal(f.stream.closing, false); assert.equal(f.stream.autoFollowAudioMs, 120);
  assert.equal(f.stream.captureTimeline.sourceTime(80), 3080);
});

test('119bcbbc receive-delay pattern keeps ordered PCM continuous instead of dropping and reconnecting', t => {
  const f = createFixture({lineCount: 3}); t.after(() => f.dispose());
  let now = 100000; t.mock.method(Date, 'now', () => now);
  Object.assign(f.stream, {captureId: 'current', captureClock: 'audio-thread-v2', captureTimeline: new LiveAudioTimeline('mic')});
  const events = []; f.history.event = (_id, type, data) => events.push({type, ...data});
  const delays = [0, 1831, 2577, 5598, 5640, 6938, 9293];
  for (let i = 0; i < delays.length; i++) {
    now = 100000 + i * 40 + delays[i];
    const reply = f.send({sessionId: f.session.id, captureId: 'current', sourceId: 'mic', sequence: i + 1,
      capturedAt: 100000 + i * 40, captureAgeMs: 1, sourceStartMs: i * 40, sourceEndMs: i * 40 + 40,
      audio: Buffer.alloc(1920).toString('base64'), durationMs: 40, level: .001});
    assert.equal(reply.ok, true); assert.notEqual(reply.dropped, true);
  }
  assert.equal(f.stream.closing, false); assert.equal(f.stream.autoFollowAudioMs, delays.length * 40);
  assert.equal(f.sent.length, delays.length); assert.equal(events.filter(e => e.type === 'audio_gap').length, 0);
});
