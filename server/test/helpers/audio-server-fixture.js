const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Load the whole application, including its real authorization, normalization,
// Socket.IO handlers and provider adapters. Only startup is replaced: tests must
// never load the operator's store, listen on a port or contact an ASR service.
module.exports = function createAudioServerFixture({ lineCount = 1000 } = {}) {
  const filename = require.resolve('../../src/server');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /startServer\(\);\s*$/);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source.replace(/startServer\(\);\s*$/, `
    module.exports = function (lineCount) {
      const user = { id: 'audio-load-owner', role: USER_ROLES.OPERATOR };
      users.set(user.id, user);
      const token = 'local-audio-load-test';
      authSessions.set(hashToken(token), {
        tokenHash: hashToken(token), userId: user.id, expiresAt: Date.now() + 60000,
      });
      const session = createSessionRecord(user.id);
      session.subtitleControlMode = SUBTITLE_CONTROL_MODES.AUTO;
      session.lines = Array.from({ length: lineCount }, (_, i) => ({
        id: 'line-' + i, type: LINE_TYPES.DIALOGUE,
        text: '這是第' + i + '句舞台演出的台詞，需要持續跟隨演員說話',
        translations: { primary: '這是第' + i + '句舞台演出的台詞，需要持續跟隨演員說話' },
      }));
      session.sharedLines = session.lines;
      session.cells = Array.from({ length: 3 }, (_, i) =>
        createCellDefinition({ id: 'cell-' + i, lines: session.lines }, i));
      session.selectedCellId = session.cells[0].id;
      ensureSessionStructure(session);
      sessions.set(session.id, session);
      persistSession = persistSessionCurrentIndexSoon = () => {
        throw new Error('Audio fixture must not write application data');
      };
      let structureCalls = 0, lineCalls = 0;
      const normalizeStructure = ensureSessionStructure;
      const normalizeLines = ensureSessionLines;
      ensureSessionStructure = (s) => { structureCalls++; return normalizeStructure(s); };
      ensureSessionLines = (s) => { lineCalls++; return normalizeLines(s); };
      const sent = [];
      const transport = {
        readyState: WebSocket.OPEN, bufferedAmount: 0,
        send: data => sent.push(data), close() { this.readyState = WebSocket.CLOSED; },
      };
      const stream = {
        provider: 'deepgram', socketId: 'load-socket', ready: true, closing: false,
        socket: transport, rt: {
          socket: transport, send: data => sent.push(data), close: () => transport.close(),
        },
        pendingAudioChunks: [], autoFollowAudioMs: 0, audioBytesSent: 0,
        trailingSilenceMs: 0, pendingAppendCount: 0, pendingAudioMs: 0,
      };
      transcriptionStreams.set(session.id, stream);
      function connect(cookie = AUTH_COOKIE_NAME + '=' + token, socketId = 'load-socket') {
        const handlers = new Map();
        const socket = {
          id: socketId, handshake: { headers: { cookie } }, data: {},
          on: (event, handler) => handlers.set(event, handler), emit() {},
        };
        io.listeners('connection')[0](socket);
        return (payload) => {
          let result;
          handlers.get('transcription:audio')(payload, value => { result = value; });
          return result;
        };
      }
      return {
        server, session, stream, user, sent, connect, send: connect(),
        counts: () => ({ structures: structureCalls, lines: lineCalls }),
        transcript: (text, options) => handleAutoFollowTranscript(session.id, text, options),
        state: () => getPublicAutoFollowState(session),
        dispose() {
          for (const timer of currentIndexPersistTimers.values()) clearTimeout(timer);
          for (const timer of latestRoomStateKeyframes.values()) clearTimeout(timer);
        },
      };
    };
  `), filename);
  return loaded.exports(lineCount);
};
