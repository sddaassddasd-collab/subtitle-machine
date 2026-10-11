const { test } = require('node:test');
const assert = require('node:assert/strict');
const createFixture = require('./helpers/audio-server-fixture');

const lines = [
  '我一直以為你不會再回來',
  { type: 'direction', text: '（兩人離場，燈光漸暗）' },
  { type: 'direction', text: '（長時間舞台動作）' },
  '可是我答應過你',
];
const audio = Buffer.alloc(960).toString('base64');
function replay(t, provider = 'deepgram') {
  const f = createFixture({ texts: lines, allowCueChanges: true });
  t.after(() => f.dispose());
  f.stream.provider = provider;
  let sequence = 0;
  const send = (level, count = 1, extra = {}) => {
    for (let i = 0; i < count; i++) {
      assert.equal(f.send({ sessionId: f.session.id, audio, durationMs: 20,
        level, sequence: ++sequence, ...extra }).ok, true);
    }
  };
  const confirm = () => f.transcript(lines[0], {
    streamId: 'stage-test', itemId: 'a', startMs: 0, endMs: 1000, isFinal: false,
  });
  return { f, send, confirm };
}

for (const provider of ['deepgram', 'openai']) {
  test(`${provider}: stage silence clears viewer/projector text, keeps direction available to prompters, then resumes dialogue`, t => {
    const { f, send, confirm } = replay(t, provider);
    send(0.08, 50);
    confirm();
    send(0.001, 149);
    assert.equal(f.session.currentIndex, 0);
    assert.deepEqual(f.counts(), { structures: 0, lines: 0 });
    send(0.001);
    assert.equal(f.session.currentIndex, 1);
    assert.deepEqual(f.cueChanges, [1]);
    assert.equal(f.state().lastDecision.source, 'silence');
    assert.equal(f.state().predictedIndex, null);
    assert.match(f.state().message, /靜默 3 秒/);
    for (const payload of [f.viewer(), f.projector()]) {
      assert.equal(payload.text, '');
      assert.equal(payload.line.type, 'direction');
      assert.equal(payload.line.text, lines[1].text);
      assert.equal(payload.displayEnabled, true); // Next dialogue remains visible.
      assert.equal(payload.source, 'script');
      assert.ok(payload.autoFollowDecision.id);
    }
    assert.equal(f.viewer().lines[1].text, lines[1].text);
    assert.equal(f.stream.ready, true);
    assert.equal(f.stream.closing, false);
    assert.equal(f.stream.socket.readyState, 1);
    f.transcript(lines[0], {streamId: 'stage-test', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
    send(0.001, 1000);
    assert.equal(f.session.currentIndex, 1);
    assert.equal(f.viewer().text, '');
    f.transcript(lines[3], {streamId: 'stage-test', itemId: 'b', startMs: 24100, endMs: 25000, isFinal: true});
    assert.equal(f.session.currentIndex, 3);
    assert.equal(f.viewer().text, lines[3]);
    assert.equal(f.projector().text, lines[3]);
    assert.equal(f.session.subtitleControlMode, 'auto');
  });
}

test('stale captured audio and paused microphone input cannot clear a direction early', t => {
  const { f, send, confirm } = replay(t);
  send(0.08, 50);
  confirm();
  send(0.001, 149);
  send(0.001, 500, {stale: true});
  assert.equal(f.session.currentIndex, 0);
  send(0.001, 149);
  assert.equal(f.session.currentIndex, 0);
  send(0.001);
  assert.equal(f.session.currentIndex, 1);
});

test('manual mode and manual repositioning disable the pending direction advance', t => {
  const { f, send, confirm } = replay(t);
  send(0.08, 50);
  confirm();
  f.session.subtitleControlMode = 'manual';
  send(0.001, 300);
  assert.equal(f.session.currentIndex, 0);
  f.session.subtitleControlMode = 'auto';
  f.resetPosition();
  send(0.001, 300);
  assert.equal(f.session.currentIndex, 0);
});

test('new dialogue arriving during the countdown replaces the old caption without clearing it later', t => {
  const { f, send, confirm } = replay(t);
  send(0.08, 50);
  confirm();
  send(0.001, 100);
  f.transcript(lines[3], { streamId: 'stage-test', itemId: 'b', startMs: 3100, endMs: 4000, isFinal: true });
  assert.equal(f.session.currentIndex, 3);
  send(0.001, 400);
  assert.equal(f.session.currentIndex, 3);
  assert.equal(f.viewer().text, lines[3]);
});

test('provider speech detection cancels quiet-microphone countdown even before any new transcript arrives', t => {
  const { f, send, confirm } = replay(t);
  send(0.08, 50);
  confirm();
  send(0.001, 149);
  f.speechStarted();
  // A late final of the old utterance must not restart a canceled countdown.
  f.transcript(lines[0], {streamId: 'stage-test', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  send(0.001, 300);
  assert.equal(f.session.currentIndex, 0);
  assert.equal(f.viewer().text, lines[0]);
});
