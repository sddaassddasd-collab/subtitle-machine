const {test} = require('node:test');
const assert = require('node:assert/strict');
const {FollowTrace, trackerSnapshot, transcriptDetails, clientMetadata} = require('../src/follow-trace');
const {CaptureSummary, AcousticSummary} = require('../src/follow-metrics');
const {DIAGNOSTIC_SETTINGS: D, FOLLOW_SETTINGS} = require('../src/follow-settings');
const {createTracker, followTranscript} = require('../src/auto-follow');

test('decision windows retain pre/post samples, coalesce triggers and never duplicate sample IDs', () => {
  const trace = new FollowTrace(), chunks = [];
  for (let at = 0; at <= 6000; at += 100) chunks.push(...trace.observe(at, 'audio', 'below_threshold', {confidence: 0.7}));
  const trigger = trace.trigger(6000, 'cue_enter', {index: 2}); chunks.push(...trigger);
  assert.ok(trigger[0].samples.every(sample => sample.at >= 1000));
  chunks.push(...trace.observe(6100, 'audio', 'awaiting_support', {confidence: 0.81}));
  const windowId = trace.window.id;
  chunks.push(...trace.trigger(6200, 'problem_mark'));
  assert.equal(trace.window.id, windowId);
  chunks.push(...trace.observe(7000, 'audio', 'awaiting_support', {confidence: 0.82}));
  chunks.push(...trace.flush(9300));
  assert.equal(trace.window, null);
  const samples = chunks.flatMap(chunk => chunk.samples);
  assert.equal(samples.length, new Set(samples.map(sample => sample.sampleId)).size);
  assert.ok(samples.some(sample => sample.at === 7000), 'post-trigger evidence is persisted');
  assert.ok(chunks.some(chunk => chunk.reason === 'reason_changed' && chunk.previousReason === 'below_threshold'));
});

test('trace rings have a hard cap and explicitly report truncation during bursts', () => {
  const trace = new FollowTrace();
  trace.observe(0, 'audio', 'same', {}); trace.flush(4000);
  for (let i = 0; i < 10000; i++) trace.observe(5000, 'audio', 'same', {candidateIndex: i % 2});
  assert.equal(trace.ring.length, D.maxRingSamples);
  const chunks = trace.trigger(5000, 'problem_mark');
  assert.ok(chunks[0].truncatedSamples > 0);
  assert.equal(chunks[0].samples.length, D.maxRingSamples);
});

test('transcript snapshots preserve words and flags, bound long input and allowlist client metadata', () => {
  const words = [{word: '你好', start: 1.25, end: 1.75, confidence: 0.82, punctuated_word: '你好，'}];
  const detail = transcriptDetails('你好', {words, isFinal: true, order: 2, itemId: 'segment', streamId: 'stream'});
  assert.equal(detail.words[0].startMs, 1250); assert.equal(detail.words[0].endMs, 1750);
  assert.equal(detail.words[0].confidence, 0.82); assert.equal(detail.isFinal, true);
  assert.equal(transcriptDetails('x', {}).wordsAvailable, false);
  const huge = transcriptDetails('字'.repeat(4000), {words: Array(400).fill(words[0])});
  assert.equal(huge.words.length, D.maxWords); assert.equal(huge.wordsTruncated, true);
  assert.equal(huge.text.length, D.maxTranscriptChars); assert.equal(huge.textTruncated, true);
  const meta = clientMetadata({apiKey: 'never-save-this', build: {commit: 'test-commit'},
    audio: {sampleRate: 48000, deviceId: 'private-device', echoCancellation: false}});
  assert.deepEqual(meta.audio, {sampleRate: 48000, echoCancellation: false});
  assert.ok(!JSON.stringify(meta).includes('never-save-this'));
  assert.equal(meta.build.commit, 'test-commit');
});

test('audio summaries distinguish threshold passes, candidate switches, support interruptions and actual acceptance', () => {
  const summary = new AcousticSummary(0);
  const add = (index, confidence, reason, supportResetReason, accepted = false) => summary.add(100, reason,
    {candidateIndex: index, confidence, accepted,
      acoustic: {minimumConfidence: 0.8, minimumMargin: 0.035, margin: 0.04, supportCount: 1, supportResetReason}});
  add(2, 0.79, 'below_threshold', null); add(2, 0.82, 'awaiting_support', null);
  add(3, 0.83, 'awaiting_support', 'candidate_changed'); add(2, 0.85, 'superseded_by_text', 'candidate_changed');
  add(2, 0.86, 'audio_accepted', null, true);
  assert.equal(summary.data.comparisons, 5); assert.equal(summary.data.thresholdPasses, 4);
  assert.equal(summary.data.maxConfidence, 0.86); assert.equal(summary.data.candidateSwitches, 2);
  assert.equal(summary.data.supportBreaks.candidate_changed, 2); assert.equal(summary.data.accepted, 1);
});

test('capture summaries preserve sequence continuity across summary boundaries and count poor audio and missing packets', () => {
  const first = new CaptureSummary(0, 'a');
  first.add(20, {sequence: 1, level: 0.001, stale: true, quality: {peak: 1, samples: 480, clippedSamples: 4}});
  first.add(40, {sequence: 1, level: 0.1});
  const next = new CaptureSummary(5000, 'a', first);
  next.add(5200, {sequence: 4, level: 0.1, queued: true, clientAgeMs: 300}); next.drop('startup_queue', 2);
  assert.equal(first.data.clippedPackets, 1); assert.equal(first.data.duplicates, 1);
  assert.equal(first.data.quietPackets, 1); assert.equal(first.data.stalePackets, 1);
  assert.equal(next.data.missingSequences, 2); assert.equal(next.data.maxReceiveGapMs, 5160);
  assert.equal(next.data.droppedPackets, 2); assert.equal(next.data.maxClientAgeMs, 300);
  assert.equal(new CaptureSummary(0, undefined).lastSequence, null);
  assert.equal(new CaptureSummary(0, 'b', next).lastSequence, null, 'a reconnect starts a new sequence clock');
});

test('ignored recognition has specific reasons and a stable snapshot without leaking mutable tracker state', () => {
  const tracker = createTracker(), lines = [{text: '我們今晚正式開始演出'}];
  const event = {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, text: lines[0].text};
  followTranscript(tracker, lines, 0, event);
  const snapshot = trackerSnapshot(tracker, 0);
  assert.equal(followTranscript(tracker, lines, 0, event).reason, 'duplicate_interim');
  followTranscript(tracker, lines, 0, {...event, isFinal: true});
  assert.equal(followTranscript(tracker, lines, 0, {...event, isFinal: true}).reason, 'item_already_final');
  assert.equal(snapshot.progress, 1); assert.equal(FOLLOW_SETTINGS.acoustic.minimumConfidence, 0.8);
  assert.ok(Object.isFrozen(FOLLOW_SETTINGS.acoustic));
});
