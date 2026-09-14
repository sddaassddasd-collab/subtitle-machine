const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createTracker, prepareScript, followTranscript, followAudio } = require('../src/auto-follow');
const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');

// Execute the real server functions, replacing only IO/persistence dependencies.
function loadFunctions(context, first, following) {
  const start = source.indexOf(`function ${first}(`);
  const end = source.indexOf(`function ${following}(`, start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
}
function fixture(mode = 'auto') {
  const session = {
    id: 'test', subtitleControlMode: mode, currentIndex: 0,
    lines: [{ text: '我一直以為你不會再回來' }, { text: '可是我答應過你' }],
    cells: [], selectedCellId: 'cell', displayEnabled: true, projectorDisplayMode: 'transcription',
  };
  const emissions = [];
  const context = vm.createContext({
    Date, crypto: require('node:crypto'), createTracker, prepareScript, followTranscript, followAudio, console: { error() {} },
    AUTO_FOLLOW_STATUS: { IDLE: 'idle', LISTENING: 'listening', ADVANCED: 'advanced', SEARCHING: 'searching' },
    AUTO_FOLLOW_AUDIO_LEVEL_THRESHOLD: 0.04, AUTO_FOLLOW_AUDIO_RELEASE_THRESHOLD: 0.018,
    AUTO_FOLLOW_DIAGNOSTIC_BROADCAST_MS: 250, DEFAULT_SESSION_ID: 'test',
    SUBTITLE_CONTROL_MODES: { AUTO: 'auto', MANUAL: 'manual' },
    PROJECTOR_DISPLAY_MODES: { SCRIPT: 'script', TRANSCRIPTION: 'transcription' },
    LINE_TYPES: { DIRECTION: 'direction', DIALOGUE: 'dialogue' },
    sessions: new Map([[session.id, session]]),
    autoFollowStates: new Map(), transcriptionStreams: new Map(),
    getSession: () => session, getSessionRecord: () => session,
    ensureSessionLines: s => s.lines, sanitizeLineText: t => String(t).trim(),
    getSelectedCell: () => null, toPublicLine: line => line,
    getViewerStateRevision: () => 1, normalizeProjectorDisplayMode: x => x,
    normalizeProjectorLanguageMode: () => 'single',
    persistSessionCurrentIndexSoon: () => {}, persistSession: () => {},
    broadcastViewerState: () => emissions.push('viewer'),
    broadcastControlState: () => emissions.push('control'),
    broadcastTranscriptionState: () => emissions.push('transcription'),
    broadcastAutoFollowState: () => emissions.push('diagnostics'),
    getLiveTranscriptionPatchPayload: () => ({ active: true }),
    hasSocketRoomConnections: () => true,
    emitLatestRoomState: (room, event) => emissions.push(event),
    io: { to: () => ({ emit: event => emissions.push(event) }) },
    getSessionDisplayState: s => ({
      normalized: s, activeScriptLine: s.lines[s.currentIndex],
      liveEntries: [], liveLines: ['即時辨識結果'], liveText: '即時辨識結果',
      hasLiveText: true, musicActive: false, musicText: '', transcription: { active: true },
    }),
  });
  loadFunctions(context, 'applyCurrentIndexChange', 'broadcastProjectorState');
  loadFunctions(context, 'getViewerPayload', 'getProjectorLayoutPayload');
  loadFunctions(context, 'broadcastLiveTranscriptionState', 'getLiveTranslationPatchPayload');
  return { session, context, emissions };
}

test('automatic viewers and projectors both show the edited script while ASR runs', () => {
  const { context, session } = fixture();
  for (const payload of [context.getViewerPayload(session), context.getProjectorPayload(session)]) {
    assert.equal(payload.source, 'script');
    assert.equal(payload.text, session.lines[0].text);
  }
});

test('manual live-transcription mode is preserved', () => {
  const { context, session } = fixture('manual');
  assert.equal(context.getViewerPayload(session).source, 'transcription');
  assert.equal(context.getProjectorPayload(session).source, 'transcription');
});

test('live patches cannot overwrite automatic script output', () => {
  const { context, emissions } = fixture();
  context.broadcastLiveTranscriptionState('test', {});
  assert.deepEqual(emissions, []);
});

test('live patches still reach manual live displays', () => {
  const { context, emissions } = fixture('manual');
  context.broadcastLiveTranscriptionState('test', {});
  assert.ok(emissions.includes('viewer:live-update'));
  assert.ok(emissions.includes('prompter:live-update'));
  assert.ok(emissions.includes('projector:live-update'));
});

test('hidden displays stay hidden while following', () => {
  const { context, session } = fixture(); session.displayEnabled = false;
  assert.equal(context.getViewerPayload(session).source, 'hidden');
  assert.equal(context.getProjectorPayload(session).source, 'hidden');
});

test('manual reposition preserves automatic mode and fences old recognition', () => {
  const { context, session } = fixture();
  context.transcriptionStreams.set('test', { ready: true, autoFollowAudioMs: 2000 });
  context.applyCurrentIndexChange(session, 1, { manualOverride: true });
  assert.equal(session.subtitleControlMode, 'auto');
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's', itemId: 'old', startMs: 0, endMs: 1000, isFinal: true,
  });
  assert.equal(session.currentIndex, 1);
});

test('interim verification emits a small diagnostic update, not a full script', () => {
  const { context, session, emissions } = fixture();
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: false,
  });
  assert.deepEqual(emissions, ['diagnostics']);
  assert.equal(context.getPublicAutoFollowState(session).armedIndex, 1);
});

test('both provider adapters preserve audio timing and segment identity', () => {
  const { context } = fixture();
  const stream = { liveTranslationStreamId: 'stream', autoFollowItems: new Map([
    ['openai-item', { startMs: 400, endMs: 1800 }],
  ]) };
  const realtime = context.getAutoFollowTranscriptOptions(stream, 'openai-item', true);
  const deepgram = context.getAutoFollowTranscriptOptions(stream, 'deepgram-0.500', false,
    { startMs: 500, endMs: 1700 });
  assert.equal(realtime.startMs, 400); assert.equal(realtime.endMs, 1800);
  assert.equal(realtime.itemId, 'openai-item'); assert.equal(realtime.isFinal, true);
  assert.equal(deepgram.startMs, 500); assert.equal(deepgram.endMs, 1700);
  assert.equal(deepgram.streamId, 'stream');
});

test('an alignment exception is contained and the next transcript can recover', () => {
  const { context, session, emissions } = fixture();
  context.followTranscript = () => { throw new Error('test alignment failure'); };
  assert.doesNotThrow(() => context.handleAutoFollowTranscript('test', '測試'));
  assert.equal(session.currentIndex, 0);
  assert.equal(context.getPublicAutoFollowState(session).status, 'searching');
  assert.deepEqual(emissions, ['diagnostics']);
  context.followTranscript = followTranscript;
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's', itemId: 'after-error', startMs: 1000, endMs: 2000,
  });
  assert.equal(context.getPublicAutoFollowState(session).armedIndex, 1);
});

test('capture worklet emits 20 ms mono PCM frames with no missing samples', () => {
  let Processor;
  const packets = [];
  const context = vm.createContext({
    sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => packets.push(data) }; } },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../../client/src/worklets/mic-capture-processor.js'), 'utf8'), context);
  const processor = new Processor();
  for (let i = 0; i < 15; i += 1) {
    processor.process([[new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.75)]]);
  }
  assert.equal(packets.length, 2);
  assert.equal(packets[0].length, 960);
  assert.equal(packets[1].length, 960);
  assert.ok(packets.every(packet => packet.every(sample => sample === 0.5)));
});

test('changing a performance cell clears the previous tracking anchor', () => {
  const { context, session } = fixture();
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true,
  });
  assert.equal(context.getPublicAutoFollowState(session).armedIndex, 1);
  session.selectedCellId = 'different-cell';
  assert.equal(context.getPublicAutoFollowState(session).armedIndex, null);
});

test('display acknowledgements are scoped to the current decision, role and cell', () => {
  const { context, session, emissions } = fixture();
  context.recordAutoFollowDecision('test', 0, 'onset', { onsetDetectionMs: 40 });
  const decision = context.getPublicAutoFollowState(session).lastDecision;
  assert.equal(context.getViewerPayload(session).autoFollowDecision.id, decision.id);
  assert.equal(context.getProjectorPayload(session).autoFollowDecision.id, decision.id);
  context.handleAutoFollowDisplayAck('other-session', 'viewer', decision.id, session.selectedCellId);
  context.handleAutoFollowDisplayAck('test', 'control', decision.id, session.selectedCellId);
  context.handleAutoFollowDisplayAck('test', 'viewer', decision.id, 'another-cell');
  context.handleAutoFollowDisplayAck('test', 'viewer', 'stale-id', session.selectedCellId);
  context.handleAutoFollowDisplayAck('test', 'viewer', undefined, session.selectedCellId);
  assert.equal(emissions.length, 0);
  context.handleAutoFollowDisplayAck('test', 'viewer', decision.id, session.selectedCellId);
  assert.ok(Number.isFinite(decision.displayAckMs.viewer));
  context.handleAutoFollowDisplayAck('test', 'viewer', decision.id, session.selectedCellId);
  assert.equal(emissions.length, 1);
  session.currentIndex = 1;
  context.handleAutoFollowDisplayAck('test', 'projector', decision.id);
  assert.equal(decision.displayAckMs.projector, undefined);
});

test('recognition timing exposes audio lag separately from alignment processing time', () => {
  const { context, session } = fixture();
  context.transcriptionStreams.set('test', { autoFollowAudioMs: 3200 });
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true,
  });
  const state = context.getPublicAutoFollowState(session);
  assert.equal(state.lastTranscriptAudioLagMs, 2200);
  assert.ok(Number.isFinite(state.lastTranscriptReceivedAt));
  assert.ok(Number.isFinite(state.lastAlignmentMs));
});
