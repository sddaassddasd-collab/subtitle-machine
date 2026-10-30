const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createTracker, prepareScript, normalizeText, followTranscript, followAudio } = require('../src/auto-follow');
const {trackerSnapshot} = require('../src/follow-trace');
const {ACOUSTIC_SETTINGS} = require('../src/follow-settings');
const performanceLanguage = require('../src/performance-language');
const captionMode = require('../src/caption-mode');
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
    Date, crypto: require('node:crypto'), createTracker, prepareScript, normalizeText, followTranscript, followAudio, trackerSnapshot, ACOUSTIC_SETTINGS,
    ...performanceLanguage, ...captionMode, console: { error() {} },
    AUTO_FOLLOW_STATUS: { IDLE: 'idle', LISTENING: 'listening', ADVANCED: 'advanced', SEARCHING: 'searching' },
    AUTO_FOLLOW_AUDIO_LEVEL_THRESHOLD: 0.04, AUTO_FOLLOW_AUDIO_RELEASE_THRESHOLD: 0.018,
    AUTO_FOLLOW_DIAGNOSTIC_BROADCAST_MS: 250, DEFAULT_SESSION_ID: 'test',
    SUBTITLE_CONTROL_MODES: { AUTO: 'auto', MANUAL: 'manual' },
    PROJECTOR_DISPLAY_MODES: { SCRIPT: 'script', TRANSCRIPTION: 'transcription' },
    LINE_TYPES: { DIRECTION: 'direction', DIALOGUE: 'dialogue' },
    sessions: new Map([[session.id, session]]),
    autoFollowStates: new Map(), transcriptionStreams: new Map(),
    autoFollowHistory: {enter() {}, confirm() {}, heard() {}, observe() {}, revision() {}, sync() {}, diagnostic() {}, event() {}, status: () => ({})},
    referenceRuntime: {position() {}, invalidate() {}},
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

test('noisy interim catches up nearby and publishes edited script to displays', () => {
  const { session, context, emissions } = fixture();
  session.lines = ['你怎麼現在才來這裡', '路上出了點事情', '到底發生什麼事情', '我的車子壞了']
    .map(text => ({ text }));
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's1', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true,
  });
  emissions.length = 0;
  context.handleAutoFollowTranscript('test', '亂碼噪聲完全聽不清楚我的車子壞了', {
    streamId: 's1', itemId: 'b', startMs: 1100, endMs: 2400, isFinal: false,
  });
  assert.equal(session.currentIndex, 3);
  assert.ok(emissions.includes('viewer'));
  for (const payload of [context.getViewerPayload(session), context.getProjectorPayload(session)]) {
    assert.equal(payload.source, 'script');
    assert.equal(payload.text, '我的車子壞了');
  }
});

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

test('server advances after weak recognition while publishing both tracking lanes', () => {
  const { context, session, emissions } = fixture();
  session.lines = [{ text: '大家今天終於重新聚在一起了' },
    { text: '可是我答應過你永遠不會離開' }, { text: '請你先坐下來喝杯茶' },
    { text: '他想請你先一起討論事情' }];
  context.handleAutoFollowTranscript('test', session.lines[0].text, {
    streamId: 's', itemId: 'a', startMs: 0, endMs: 1000,
  });
  for (let time = 1020; time <= 1200; time += 20) context.handleAutoFollowAudioLevel('test', 0.001, 20, time);
  for (let time = 1220; time <= 1240; time += 20) context.handleAutoFollowAudioLevel('test', 0.08, 20, time);
  assert.equal(session.currentIndex, 1);
  context.handleAutoFollowTranscript('test', '科是他打應過你', {
    streamId: 's', itemId: 'b', startMs: 1200, endMs: 1800,
  });
  const waiting = context.getPublicAutoFollowState(session);
  assert.equal(waiting.sequenceIndex, 1);
  assert.equal(waiting.correctionStatus, 'searching');
  assert.equal(waiting.armedIndex, null);
  emissions.length = 0;
  context.handleAutoFollowTranscript('test', '請你先', {
    streamId: 's', itemId: 'c', startMs: 2000, endMs: 2300,
  });
  assert.equal(session.currentIndex, 2);
  assert.ok(emissions.includes('viewer'));
  assert.equal(context.getViewerPayload(session).text, session.lines[2].text);
  assert.equal(context.getProjectorPayload(session).text, session.lines[2].text);
  context.transcriptionStreams.set('test', { autoFollowAudioMs: 2400 });
  context.applyCurrentIndexChange(session, 0, { manualOverride: true });
  const reset = context.getPublicAutoFollowState(session);
  assert.equal(reset.sequenceIndex, null);
  assert.equal(reset.correctionCandidates.length, 0);
  context.handleAutoFollowTranscript('test', session.lines[2].text, {
    streamId: 's', itemId: 'stale', startMs: 2000, endMs: 3000, isFinal: true,
  });
  assert.equal(session.currentIndex, 0);
});

test('cross-cue transcript confirms the displayed prediction before moving, while recording intermediate coverage separately', () => {
  const {context, session} = fixture();
  session.lines = ['今晚大家都準備好了', '你哭了？', '我沒有，', '我沒有哭，', '我不知道哭是什麼意思。']
    .map((text, index) => ({id: `cue-${index}`, text}));
  const history = [], positions = [];
  context.autoFollowHistory.confirm = (_id, index, _source, data) => history.push({type: 'confirm', index, ...data});
  context.autoFollowHistory.enter = (_session, index) => history.push({type: 'enter', index});
  context.autoFollowHistory.heard = (_id, spans) => history.push({type: 'heard', spans});
  context.referenceRuntime.position = (_session, _clock, options) => positions.push(options);
  context.handleAutoFollowTranscript('test', session.lines[0].text, {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  for (let endMs = 1020; endMs <= 1200; endMs += 20) context.handleAutoFollowAudioLevel('test', 0.001, 20, endMs);
  for (let endMs = 1220; endMs <= 1240; endMs += 20) context.handleAutoFollowAudioLevel('test', 0.08, 20, endMs);
  assert.equal(session.currentIndex, 1);
  assert.equal(positions.at(-1).continuous, true);
  history.length = 0;
  context.handleAutoFollowTranscript('test', '你哭了嗎我沒有我沒有哭我不知道', {streamId: 's', itemId: 'b', startMs: 1200, endMs: 4200});
  assert.equal(session.currentIndex, 4);
  assert.deepEqual(Array.from(history[0].spans, span => span.index), [1, 2, 3, 4]);
  assert.deepEqual(history.slice(1).map(event => [event.type, event.index]), [['confirm', 1], ['enter', 4], ['confirm', 4]]);
  assert.equal(history[1].completed, true);
  assert.equal(positions.at(-1).continuous, false, 'a multi-cue jump resets acoustic position');
  context.applyCurrentIndexChange(session, 3, {manualOverride: true});
  assert.equal(positions.at(-1).continuous, false);
});

test('automatic positions send a small patch and preserve full updates for older control clients', () => {
  const {context, session} = fixture();
  const sent = [], patchRoom = `control-position:${session.id}`, room = `control:${session.id}`;
  const rooms = new Map([[room, new Set(['modern'])], [patchRoom, new Set(['modern'])]]);
  context.io.sockets = {adapter: {rooms}};
  context.io.to = room => ({except(excluded) { this.excluded = excluded; return this; },
    emit(event, payload) { sent.push({room, event, payload, excluded: this.excluded}); }});
  let fullBuilds = 0;
  context.getControlPayload = () => {fullBuilds++; return {lines: Array(1000).fill({text: 'script'})};};
  context.broadcastControlPosition(session);
  assert.equal(fullBuilds, 0);
  assert.equal(sent[0].event, 'control:position');
  assert.equal(sent[0].payload.currentIndex, 0);
  assert.equal(sent[0].payload.lines, undefined);
  assert.equal(sent[0].payload.session, undefined);
  rooms.get(room).add('legacy');
  sent.length = 0;
  context.broadcastControlPosition(session);
  assert.equal(fullBuilds, 1);
  assert.equal(sent[0].event, 'control:update');
  assert.equal(sent[0].excluded, patchRoom);
  assert.equal(sent[1].event, 'control:position');
});

test('a trimmed tail can locate a cue without exporting it as a confirmed ending', () => {
  const {context, session} = fixture();
  session.lines = ['最有效的方法就是使用電擊治療。', '如果他沒寫出快樂的歌，', '就電一次，'].map(text => ({text}));
  const confirmations = [];
  context.autoFollowHistory.confirm = (_id, index, _source, data) => confirmations.push({index, ...data});
  context.handleAutoFollowTranscript('test', session.lines[0].text, {streamId: 's', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true});
  context.handleAutoFollowTranscript('test', '只要他沒寫出快樂的歌我', {streamId: 's', itemId: 'b', startMs: 1100, endMs: 2500});
  assert.equal(session.currentIndex, 1);
  assert.equal(confirmations.at(-1).completed, false);
  assert.equal(context.getPublicAutoFollowState(session).armedIndex, null);
});
