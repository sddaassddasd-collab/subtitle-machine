const {test} = require('node:test');
const assert = require('node:assert/strict');
const {LiveAudioTimeline, transcriptAfterGap} = require('../src/live-audio-timeline');
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
  const old = f.send(packet(2, 40, 12000)); assert.equal(old.ok, true); assert.equal(old.dropped, true)
  assert.equal(f.stream.autoFollowAudioMs, 40); assert.equal(f.stream.closing, false)
  f.stream.draftByItemId.set('old-draft', '缺口之前的暫定字幕');
  assert.equal(f.send(packet(3, 1200)).ok, true)
  assert.equal(f.stream.autoFollowAudioMs, 80); assert.equal(f.session.currentIndex, 4)
  assert.equal(f.stream.captureGapFenceMs, 40)
  assert.equal(f.stream.draftByItemId.size, 0)
  assert.equal(events.filter(e => e.type === 'audio_gap').length, 1)
  assert.equal(events.find(e => e.type === 'audio_gap').gapMs, 1160)
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 2)
  assert.equal(f.sent.some(data => typeof data === 'string' && JSON.parse(data).type === 'Finalize'), false)
  assert.equal(f.state().preparedIndex, null)
  f.transcript(f.session.lines[10].text, {itemId: 'late-before-gap', startMs: 0, endMs: 39, isFinal: true})
  assert.equal(f.session.currentIndex, 4)
  const probe = f.event('transcription:capture-probe', {captureId: 'current'})
  assert.equal(probe.ok, true); assert.equal(probe.sequence, 3); assert.equal(probe.serverAudioMs, 80)
  assert.equal(f.connect(undefined, 'stranger').event('transcription:capture-probe', {captureId: 'current'}).ok, false)
});

test('cross-gap results keep post-gap words and reject only speech entirely before the gap', () => {
  const words = [{word: '之前', start: .1, end: .3}, {word: '國王', start: .5, end: .7},
    {word: '快樂', punctuated_word: '快樂。', start: .7, end: 1}];
  const result = transcriptAfterGap('之前國王快樂。', {startMs: 0, endMs: 1000, words}, 500);
  assert.equal(result.text, '國王快樂。'); assert.equal(result.startMs, 500);
  assert.equal(result.words.length, 2);
  assert.equal(transcriptAfterGap('之前', {startMs: 0, endMs: 500}, 500), null);
  assert.equal(transcriptAfterGap('新一句', {endMs: 1000}, 500).text, '新一句');
});

test('a 40ms gap preserves a prepared next cue and does not finalize ASR', t => {
  const f = createFixture({texts: ['我一直以為你不會再回來', '可是我答應過你'], allowCueChanges: true});
  t.after(() => f.dispose());
  Object.assign(f.stream, {captureId: 'current', captureClock: 'audio-thread-v2', captureTimeline: new LiveAudioTimeline('mic')});
  f.transcript(f.session.lines[0].text, {streamId: 'asr', itemId: 'first', startMs: 0, endMs: 600, isFinal: true});
  assert.equal(f.state().preparedIndex, 1);
  for (let i = 0; i < 20; i++) {
    const sourceStartMs = i * 40 + (i >= 10 ? 40 : 0);
    assert.equal(f.send({sessionId: f.session.id, captureId: 'current', sourceId: 'mic', sequence: i + 1,
      sourceStartMs, sourceEndMs: sourceStartMs + 40, audio: Buffer.alloc(1920), durationMs: 40, level: .001}).ok, true);
  }
  assert.equal(f.state().preparedIndex, 1);
  assert.equal(f.stream.captureGapFenceMs, undefined);
  assert.equal(f.sent.some(data => typeof data === 'string' && JSON.parse(data).type === 'Finalize'), false);
});

test('actual Deepgram Results spanning a large source gap still update captions and advance the cue', t => {
  const f = createFixture({texts: ['我一直以為你不會再回來', '可是我答應過你', '這次我一定會留下來'],
    allowCueChanges: true, fakeDeepgram: true});
  t.after(() => f.dispose());
  const stream = f.startProvider({captureId: 'current', sourceId: 'mic', captureClock: 'audio-thread-v2'});
  const packet = (i, sourceStartMs) => ({sessionId: f.session.id, captureId: 'current', sourceId: 'mic', sequence: i,
    sourceStartMs, sourceEndMs: sourceStartMs + 40, audio: Buffer.alloc(1920), durationMs: 40, level: .001});
  for (let i = 0; i < 20; i++) assert.equal(f.send(packet(i + 1, i * 40)).ok, true);
  stream.socket.emit('message', JSON.stringify({type: 'Results', start: 0, duration: .8, is_final: true,
    channel: {alternatives: [{transcript: f.session.lines[0].text, words: [{word: f.session.lines[0].text, start: 0, end: .8}]}]}}));
  assert.equal(f.state().preparedIndex, 1);
  for (let i = 20; i < 40; i++) assert.equal(f.send(packet(i + 1, i * 40 + 1500)).ok, true);
  assert.equal(stream.captureGapFenceMs, 800);
  // Deepgram's container start still belongs to the old utterance. Only the
  // new words must reach both caption composition and the real cue decision.
  stream.socket.emit('message', JSON.stringify({type: 'Results', start: 0, duration: 1.6, is_final: false,
    channel: {alternatives: [{transcript: '之前的雜音可是我答應過你', words: [
      {word: '之前的雜音', start: 0, end: .7}, {word: '可是我答應過你', start: .8, end: 1.6},
    ]}]}}));
  assert.equal(stream.draftByItemId.get('deepgram-0.000'), '可是我答應過你');
  assert.equal(f.session.currentIndex, 1);
  stream.socket.emit('message', JSON.stringify({type: 'Results', start: 0, duration: .7, is_final: true,
    channel: {alternatives: [{transcript: '這次我一定會留下來', words: [{word: '這次我一定會留下來', start: 0, end: .7}]}]}}));
  assert.equal(f.session.currentIndex, 1, 'old asynchronous results cannot move the cue');
  assert.equal(stream.closing, false);
});

for (const delayedEnding of [false, true]) {
  test('a fresh acoustic onset advances one cue before next-line recognition' +
    (delayedEnding ? ' when the previous ending arrives late' : ''), t => {
    const texts = ['你怎麼現在才來這裡', '路上出了點事情', '我們先回家再說'];
    const f = createFixture({texts, allowCueChanges: true, fakeDeepgram: true});
    t.after(() => f.dispose());
    const stream = f.startProvider({captureId: 'current', sourceId: 'mic', captureClock: 'audio-thread-v2'});
    let sequence = 0;
    const packet = level => {
      const sourceStartMs = sequence * 40;
      assert.equal(f.send({sessionId: f.session.id, captureId: 'current', sourceId: 'mic', sequence: ++sequence,
        sourceStartMs, sourceEndMs: sourceStartMs + 40, audio: Buffer.alloc(1920), durationMs: 40, level}).ok, true);
    };
    const recognize = (transcript, start, end, isFinal) => stream.socket.emit('message', JSON.stringify({
      type: 'Results', start, duration: end - start, is_final: isFinal,
      channel: {alternatives: [{transcript, words: [{word: transcript, start, end}]}]},
    }));
    for (let i = 0; i < 20; i++) packet(.08);
    if (!delayedEnding) recognize(texts[0], 0, .8, false);
    for (let i = 0; i < 3; i++) packet(.001);
    assert.equal(f.session.currentIndex, 0);
    packet(.08);
    if (delayedEnding) {
      assert.equal(f.session.currentIndex, 0);
      recognize(texts[0], 0, .8, false);
    }
    assert.equal(f.viewer().text, texts[1]);
    assert.equal(f.state().lastDecision.source, 'onset');
    assert.equal(f.state().lastDecision.onsetAudioMs, 920);
    for (let i = 0; i < 8; i++) packet(.08);
    recognize('演員講了別的內容', .92, 1.28, true);
    for (let i = 0; i < 3; i++) packet(.001);
    packet(.08);
    assert.equal(f.session.currentIndex, 1);
    for (let i = 0; i < 14; i++) packet(.08);
    recognize(texts[2], 1.4, 2, true);
    assert.equal(f.viewer().text, texts[2]);
    assert.equal(f.state().lastDecision.source, 'correction');
  });
}

test('the associated control connection can operate the follower while an independent worker owns audio', t => {
  const f = createFixture({lineCount: 3}); t.after(() => f.dispose());
  f.stream.controlSocketId = 'controller';
  const controller = f.connect(undefined, 'controller');
  assert.equal(controller.event('performance:action', {action: 'lock-script'}).ok, true);
  assert.equal(f.connect(undefined, 'another-controller').event('performance:action', {action: 'lock-script'}).ok, false);
});

test('an operator-selected cue is an immediate anchor and accepts only fresh words to follow the next cue', t => {
  const texts = ['舊的位置請先停一下', '現在大家準備進場', '遠方傳來一陣雷聲'];
  const f = createFixture({texts, allowCueChanges: true, fakeDeepgram: true});
  t.after(() => f.dispose());
  f.allowSettings();
  const stream = f.startProvider();
  stream.autoFollowAudioMs = 2000;
  const controls = f.connect(undefined, 'separate-controller');
  controls.event('setCurrentIndex', {index: 1});
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.session.subtitleControlMode, 'auto');
  assert.equal(f.state().manualPositionIndex, 1);
  assert.equal(f.state().progressIndex, null);
  assert.equal(f.state().lastVerifiedAt, null);
  assert.equal(f.viewer().text, texts[1]);

  const say = (itemId, startMs, endMs, text, words) => f.transcript(text, {
    itemId, streamId: stream.liveTranslationStreamId, startMs, endMs, isFinal: true, words,
  });
  say('old', 500, 2000, texts[0]);
  say('ambience', 2010, 2400, '麥克風測試');
  assert.equal(f.state().manualPositionIndex, 1);
  assert.equal(f.session.currentIndex, 1);

  stream.autoFollowAudioMs = 2500;
  controls.event('setCurrentIndex', {index: 1});
  assert.equal(f.state().manualPositionIndex, 1);
  assert.equal(f.currentStream(), stream);
  say('overlap', 2200, 3500, texts[0] + texts[2], [
    {word: texts[0], startMs: 2200, endMs: 2500},
    {word: texts[2], startMs: 2500, endMs: 3500},
  ]);
  assert.equal(f.session.currentIndex, 2);
  assert.equal(f.state().manualPositionIndex, null);
  assert.equal(f.state().progressIndex, 2);
  assert.equal(f.viewer().text, texts[2]);
});

test('the control preview shows interim and final speech even when it does not match a cue', t => {
  const f = createFixture({texts: ['請大家從舞台左側進場', '燈光落下後慢慢轉身'],
    allowCueChanges: true, fakeDeepgram: true});
  t.after(() => f.dispose());
  const stream = f.startProvider();
  const preview = () => f.control().transcription.recognitionPreview;
  const recognize = (text, start, isFinal) => stream.socket.emit('message', JSON.stringify({
    type: 'Results', start, duration: 1, is_final: isFinal,
    channel: {alternatives: [{transcript: text, words: [{word: text, start, end: start + 1}]}]},
  }));

  assert.equal(preview(), null);
  recognize('剛剛那個', 0, false);
  assert.deepEqual(preview(), {text: '剛剛那個', isFinal: false});
  recognize('剛剛那個聲音', 0, true);
  assert.deepEqual(preview(), {text: '剛剛那個聲音', isFinal: true});
  recognize('剛剛那個', 0, false);
  assert.deepEqual(preview(), {text: '剛剛那個聲音', isFinal: true});
  assert.equal(f.session.currentIndex, 0);
  assert.equal(f.viewer().text, '請大家從舞台左側進場');
  assert.equal(f.viewer().transcription.recognitionPreview, undefined);
  assert.equal(f.projector().transcription.recognitionPreview, undefined);

  recognize('麥克風還開著嗎', 1, false);
  recognize('剛剛那個聲音。', 0, true);
  assert.deepEqual(preview(), {text: '麥克風還開著嗎', isFinal: false});

  f.event('transcription:stop', {});
  assert.equal(preview(), null);
  f.startProvider();
  assert.equal(preview(), null);
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
