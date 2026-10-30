const {test} = require('node:test');
const assert = require('node:assert/strict');
const {RecordingRuntime} = require('../src/recording-runtime');
const {extractFeatures} = require('../src/acoustic-follow');
const {hashText} = require('../src/recordings');
const {phrasePcm, phrases} = require('./helpers/reference-audio');
const {ACOUSTIC_SETTINGS: A} = require('../src/follow-settings');

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Recording worker did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('real worker preserves partial PCM and acoustic history on sequential advance, resets on manual position and gaps', async t => {
  const line = {id: 'b', text: '請你先坐下來喝杯茶', type: 'dialogue'};
  const session = {id: 'runtime-fixture', selectedCellId: 'act', subtitleControlMode: 'auto',
    transcriptionLanguage: 'zh-TW', currentIndex: 0, activeRecordingId: 'r',
    lines: [{id: 'a', text: '大家都已經離開了', type: 'dialogue'}, line],
    recordings: [{id: 'r', revision: 1, cellId: 'act', language: 'zh-TW', scriptLanguageId: 'primary', status: 'ready', duration: 1.44,
      playbackDuration: 1.64, featureCalibration: {scale: 1, offset: 0.2},
      segments: [{lineId: line.id, textHash: hashText(line), start: 0.2, end: 1.64, status: 'review'}]}]};
  const results = [], diagnostics = [];
  const runtime = new RecordingRuntime({loadAsset: async () => extractFeatures(phrasePcm(phrases[0])),
    onResult: (_id, result) => results.push(result), onDiagnostic: (_id, type, data) => diagnostics.push({type, ...data})});
  t.after(() => runtime.dispose());
  await runtime.ensure(session);
  const entry = runtime.sessions.get(session.id);
  await waitFor(() => entry.ready);
  const take = phrasePcm(phrases[0], 24000);
  let audioMs = 0, sequence = 0, offset = 0;
  const feed = async count => {
    for (let i = 0; i < count; i++) {
      const pcm = take.subarray(offset % (take.length - 960), offset % (take.length - 960) + 960);
      audioMs += 20; offset += 960;
      runtime.feed(session, {lastCaptureSequence: ++sequence}, pcm.toString('base64'), audioMs);
      if (i % 6 === 5) await waitFor(() => entry.pending === 0);
    }
    await waitFor(() => entry.pending === 0);
  };
  await feed(23); // 11 feature frames plus half of the next PCM frame.
  assert.equal(results.length, 0);
  const oldGeneration = entry.generation;
  session.currentIndex = 1;
  runtime.position(session, audioMs, {continuous: true, reason: 'sequential_advance'});
  assert.equal(runtime.accepts(session.id, {recordingId: 'r', generation: oldGeneration}), false);
  await feed(1);
  assert.equal(results.at(-1).status, 'candidate');
  assert.equal(results.at(-1).diagnostics.liveFrames, 12, 'the half-frame and all eleven previous frames survive');
  assert.equal(results.at(-1).segmentStatus, 'review');
  assert.equal(results.at(-1).referenceSeconds, results.at(-1).diagnostics.candidates[0].referenceSeconds,
    'candidate diagnostics use the calibrated playback clock too');
  await feed(16);
  assert.ok(results.some(result => result.status === 'verified'));
  assert.ok(results.every(result => result.generation === entry.generation));
  assert.ok(Number.isFinite(results.at(-1).workerTiming.queueMs));
  assert.ok(Number.isFinite(results.at(-1).workerTiming.processingMs));
  assert.ok(diagnostics.some(event => event.type === 'audio_position' && event.buffersPreserved));

  const before = results.length;
  runtime.position(session, audioMs, {reason: 'manual_position'});
  await feed(23);
  assert.equal(results.length, before, 'manual positioning must collect a fresh window');
  await feed(1);
  assert.equal(results.at(-1).diagnostics.liveFrames, 12);
  assert.equal(results.at(-1).diagnostics.supportCount, 1);
  audioMs += 500;
  const after = results.length;
  await feed(1);
  assert.equal(results.length, after, 'a capture gap clears earlier evidence');
  assert.ok(diagnostics.some(event => event.reason === 'audio_gap' && !event.buffersPreserved));
  runtime.position(session, audioMs, {continuous: false, reason: 'manual_position'});
  assert.equal(diagnostics.at(-1).buffersPreserved, false);

  const resetCount = diagnostics.filter(event => event.reason === 'worker_backpressure').length;
  const burstGeneration = entry.generation;
  for (let i = 0; i < 25; i++) {
    audioMs += 20;
    runtime.feed(session, {lastCaptureSequence: ++sequence}, take.subarray(i * 960, (i + 1) * 960).toString('base64'), audioMs);
  }
  await waitFor(() => entry.pending === 0 && entry.inFlight === 0);
  assert.equal(entry.generation, burstGeneration, 'a 500 ms arrival burst is batched without clearing feature history');
  assert.equal(diagnostics.filter(event => event.reason === 'worker_backpressure').length, resetCount);

  // A stalled worker plus repeated manual moves must not bypass the queue cap
  // by assigning a new generation on every move.
  const post = entry.worker.postMessage.bind(entry.worker), waiting = [];
  entry.worker.postMessage = message => waiting.push(message);
  for (let i = 0; i < 30; i++) {
    session.currentIndex = i % 2;
    runtime.position(session, audioMs, {reason: 'manual_position'});
    audioMs += 20;
    runtime.feed(session, {lastCaptureSequence: ++sequence}, take.subarray(0, 960).toString('base64'), audioMs);
    await new Promise(resolve => setImmediate(resolve));
  }
  const queued = waiting.filter(message => message.type === 'audio');
  assert.equal(queued.length, A.maxInFlight, 'the cap includes work from older generations');
  for (let i = 0; i < 70; i++) {
    audioMs += 20;
    runtime.feed(session, {lastCaptureSequence: ++sequence}, take.subarray(0, 960).toString('base64'), audioMs);
  }
  assert.ok(entry.inFlightAudioMs + entry.queuedAudioMs <= A.maxBufferedAudioMs);
  assert.ok(diagnostics.some(event => event.reason === 'worker_backpressure' && event.droppedAudioMs > 0 && !event.buffersPreserved));
  entry.worker.postMessage = post;
  post({type: 'position', generation: entry.generation, currentIndex: session.currentIndex, preserve: false});
  for (const message of queued) entry.worker.emit('message', {type: 'result', generation: message.generation, jobId: message.jobId, result: null});
  await feed(1);
  await waitFor(() => entry.inFlight === 0);
  assert.equal(entry.jobs.size, 0, 'obsolete generations still acknowledge their work and release capacity');
  audioMs += 700;
  runtime.feed(session, {lastCaptureSequence: ++sequence}, Buffer.alloc(24000 * 2 * 0.7).toString('base64'), audioMs);
  assert.equal(entry.queuedAudioMs, 0, 'a single oversized packet cannot bypass the duration bound');
  assert.ok(diagnostics.at(-1).droppedAudioMs >= 700);
});
