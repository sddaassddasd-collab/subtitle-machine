const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const createFixture = require('./helpers/audio-server-fixture');

const audio = Buffer.alloc(960, 1).toString('base64'); // 20 ms, 24 kHz PCM16 mono
const packet = (fixture, sequence) => ({
  sessionId: fixture.session.id, audio, sequence, durationMs: 20, level: 0.001,
});

for (const provider of ['deepgram', 'openai']) {
  test(`${provider}: 30 seconds of PCM uses no per-packet script normalization`, t => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    fixture.stream.provider = provider;
    const originalLines = fixture.session.lines;
    const originalCells = fixture.session.cells;
    assert.equal(originalLines.length, 1000);
    const start = performance.now();
    for (let sequence = 1; sequence <= 1500; sequence++) {
      assert.equal(fixture.send(packet(fixture, sequence)).ok, true);
    }
    t.diagnostic(`1500 packets / 1000 lines / 3 cells: ${(performance.now() - start).toFixed(1)} ms`);
    assert.deepEqual(fixture.counts(), { structures: 0, lines: 0 });
    assert.equal(fixture.session.lines, originalLines);
    assert.equal(fixture.session.cells, originalCells);
    assert.equal(fixture.stream.autoFollowAudioMs, 30000);
    assert.equal(fixture.sent.length, 1500);
    if (provider === 'deepgram') {
      assert.equal(fixture.stream.audioBytesSent, 1500 * 960);
      assert.ok(fixture.sent.every(pcm => pcm.equals(Buffer.from(audio, 'base64'))));
    } else {
      assert.ok(fixture.sent.every(event => event.type === 'input_audio_buffer.append' && event.audio === audio));
    }
  });
}

test('audio fast path retains authorization, stream ownership and duplicate protection', t => {
  const fixture = createFixture({ lineCount: 2 });
  t.after(() => fixture.dispose());
  const input = packet(fixture, 1);
  assert.equal(fixture.connect('')(input).reason, 'session_not_allowed');
  assert.equal(fixture.connect(undefined, 'other-socket')(input).reason, 'transcription_not_running');
  fixture.session.ownerUserId = 'someone-else';
  assert.equal(fixture.send(input).reason, 'session_not_allowed');
  fixture.session.ownerUserId = fixture.user.id;
  assert.equal(fixture.send(input).ok, true);
  assert.equal(fixture.send(input).ignored, true);
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.stream.autoFollowAudioMs, 20);
});

for (const provider of ['deepgram', 'openai']) {
  test(`${provider}: backpressure stops the affected stream and reports the error`, t => {
    const fixture = createFixture({ lineCount: 2 });
    t.after(() => fixture.dispose());
    fixture.stream.provider = provider;
    fixture.stream.socket.bufferedAmount = 200000;
    const result = fixture.send(packet(fixture, 1));
    assert.equal(result.ok, false);
    assert.match(result.reason, /傳送過慢/);
    assert.equal(fixture.stream.closing, true);
    assert.equal(fixture.session.transcription.status, 'error');
    assert.equal(fixture.stream.autoFollowAudioMs, 0);
    assert.equal(fixture.send(packet(fixture, 2)).reason, 'transcription_not_running');
  });
}

test('recognition diagnostics do not rebuild the script', t => {
  const fixture = createFixture();
  t.after(() => fixture.dispose());
  const originalLines = fixture.session.lines;
  fixture.transcript(originalLines[0].text, {
    streamId: 'test', itemId: 'first', startMs: 0, endMs: 1000, isFinal: false,
  });
  assert.equal(fixture.state().armedIndex, 1);
  assert.deepEqual(fixture.counts(), { structures: 0, lines: 0 });
  assert.equal(fixture.session.lines, originalLines);
});
