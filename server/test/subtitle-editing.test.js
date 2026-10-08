const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');

// Real handlers and storage representations, with no startup, disk writes or ASR calls.
function fixture() {
  const filename = require.resolve('../src/server');
  const source = fs.readFileSync(filename, 'utf8');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  assert.match(source, /startServer\(\);\s*$/);
  loaded._compile(source.replace(/startServer\(\);\s*$/, `
    module.exports = function() {
      const owner = { id: 'editing-owner', role: USER_ROLES.OPERATOR };
      const other = { id: 'editing-other', role: USER_ROLES.OPERATOR };
      const viewer = { id: 'editing-viewer', role: USER_ROLES.VIEWER };
      [owner, other, viewer].forEach(user => users.set(user.id, user));
      const token = 'editing-test-cookie';
      authSessions.set(hashToken(token), {
        userId: owner.id, tokenHash: hashToken(token), expiresAt: Date.now() + 60000,
      });
      const session = createSessionRecord(owner.id);
      session.languages.push({ id: 'en', name: 'English', code: 'en' });
      session.cells[0].lines = [
        createLineRecord({ id: 'first', text: '第一句', translations: { primary: '第一句', en: 'first' } }),
        createLineRecord({ id: 'second', text: '第二句' }),
      ];
      syncSelectedCellLines(session);
      sessions.set(session.id, session);
      const events = [], writes = [];
      io.to = room => ({ emit: (name, payload) => events.push({room, name, payload}) });
      persistSession = s => writes.push(serializeSessionForStorage(s));
      let failPersistence = false;
      persistApplicationStore = async () => {
        if (failPersistence) throw new Error('simulated storage failure');
        writes.push(Array.from(sessions.values()).map(serializeSessionForStorage));
      };
      const handlers = new Map();
      io.listeners('connection')[0]({
        id: 'editing-socket', data: {},
        handshake: { headers: { cookie: AUTH_COOKIE_NAME + '=' + token } },
        on: (name, fn) => handlers.set(name, fn), emit() {},
      });
      return {
        session, owner, other, viewer, events, writes,
        socket(name, payload) {
          let reply;
          handlers.get(name)({sessionId: session.id, ...payload}, result => { reply = result; });
          return reply;
        },
        async route(method, routePath, user = owner, params = {}) {
          const route = app.router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]).route;
          const req = { authUser: user, params: {sessionId: session.id, ...params}, body: {} };
          const res = { code: 200, status(code) { this.code = code; return this; },
            json(body) { this.body = body; return this; } };
          for (const layer of route.stack) {
            let proceed = false;
            await layer.handle(req, res, () => { proceed = true; });
            if (!proceed) break;
          }
          return { status: res.code, body: res.body };
        },
        stored: () => serializeSessionForStorage(session),
        reload: () => ensureSessionStructure(JSON.parse(JSON.stringify(serializeSessionForStorage(session)))),
        backup: () => createImportedSessionFromBackup(buildSessionBackupPayload(session), owner),
        displays: () => [getViewerPayload(session), getProjectorPayload(session)],
        failPersistence() { failPersistence = true; },
        startStream() {
          const stream = { provider: 'deepgram', ready: true, pendingAudioChunks: [],
            socket: { readyState: WebSocket.OPEN, send() {}, close() { this.readyState = WebSocket.CLOSED; } } };
          transcriptionStreams.set(session.id, stream);
          currentIndexPersistTimers.set(session.id, setTimeout(() => {}, 10000));
          deepgramReconnectTimers.set(session.id, setTimeout(() => {}, 10000));
          return stream;
        },
        hasSession: () => sessions.has(session.id),
        hasTimers: () => currentIndexPersistTimers.has(session.id) || deepgramReconnectTimers.has(session.id),
        unavailable: () => getPublicSessionUnavailablePayload('viewer', {token: session.viewerToken}),
        dispose() {
          for (const timer of currentIndexPersistTimers.values()) clearTimeout(timer);
          for (const timer of deepgramReconnectTimers.values()) clearTimeout(timer.timer || timer);
          for (const timer of latestRoomStateKeyframes.values()) clearTimeout(timer.timer || timer);
        },
      };
    };
  `), filename);
  return loaded.exports();
}

test('multiline primary and translated subtitles survive edits, storage, reload, backup and display payloads', async () => {
  const f = fixture();
  const text = '第一行\n第二行';
  assert.equal(f.socket('updateLine', {lineId: 'first', languageId: 'primary', text: ' 第一行\r\n第二行 ', expectedText: '第一句'}).ok, true);
  assert.equal(f.socket('updateLine', {lineId: 'first', languageId: 'en', text: 'Line one\nLine two', expectedText: 'first'}).ok, true);
  for (const s of [f.stored(), f.reload(), f.backup()]) {
    assert.equal(s.sharedLines[0].text, text);
    assert.equal(s.sharedLines[0].translations.en, 'Line one\nLine two');
  }
  const {normalizeDisplayPayload} = await import('../../client/src/lib/displayPayload.js');
  for (const payload of f.displays()) assert.equal(normalizeDisplayPayload(payload).line.text, text);
  assert.equal(f.socket('updateLine', {lineId: 'first', text: 'conflict', expectedText: '第一行 第二行'}).reason, 'edit_conflict');
});

test('undo and redo preserve multiline text through split, merge and delete', async () => {
  const f = fixture();
  const original = '第一行\n第二行第三行';
  f.socket('updateLine', {lineId: 'first', text: original});
  f.socket('splitLine', {index: 0, beforeText: '第一行\n第二行', afterText: '第三行', languageId: 'primary'});
  assert.equal(f.session.lines.length, 3);
  assert.equal(f.session.lines[0].text, '第一行\n第二行');
  await f.route('post', '/api/session/:sessionId/undo');
  assert.equal(f.session.lines[0].text, original);
  assert.equal(f.session.lines.length, 2);
  await f.route('post', '/api/session/:sessionId/redo');
  assert.equal(f.session.lines.length, 3);
  f.socket('mergeLineIntoPrevious', {index: 1, currentText: '第三行', languageId: 'primary'});
  assert.equal(f.session.lines[0].text, original);
  f.socket('deleteLine', {index: 0});
  assert.equal(f.session.lines.length, 1);
  await f.route('post', '/api/session/:sessionId/undo');
  assert.equal(f.session.lines[0].text, original);
});

test('type/music changes and clearing a translation leave primary line breaks intact', () => {
  const f = fixture();
  f.socket('updateLine', {lineId: 'first', text: '一\n二'});
  f.socket('setLineType', {index: 0, type: 'direction'});
  assert.equal(f.session.lines[0].text, '一\n二');
  f.socket('setLineMusic', {index: 0, music: true});
  assert.equal(f.session.lines[0].text, '一\n二');
  f.socket('updateLine', {lineId: 'first', languageId: 'en', text: ''});
  assert.equal(f.session.lines[0].text, '一\n二');
});

test('delete requires authentication and session ownership', async () => {
  const f = fixture();
  assert.equal((await f.route('delete', '/api/session/:sessionId', null)).status, 401);
  assert.equal((await f.route('delete', '/api/session/:sessionId', f.viewer)).status, 403);
  assert.equal((await f.route('delete', '/api/session/:sessionId', f.other)).status, 404);
  assert.equal(f.hasSession(), true);
  assert.equal(f.writes.length, 0);
});

test('delete removes persisted session, stops ASR, clears timers and expires all display rooms', async () => {
  const f = fixture();
  const stream = f.startStream();
  try {
    assert.equal((await f.route('delete', '/api/session/:sessionId')).status, 200);
    assert.equal(f.hasSession(), false);
    assert.deepEqual(f.writes.at(-1), []);
    assert.equal(stream.closing, true);
    assert.equal(stream.socket.readyState, 3);
    assert.equal(f.hasTimers(), false);
    assert.equal(f.unavailable().reason, 'deleted');
    for (const name of ['viewer:expired', 'projector:expired', 'control:deleted']) {
      assert.ok(f.events.some(event => event.name === name));
    }
    assert.ok(f.events.some(event => event.room === 'prompter:' + f.session.id && event.name === 'viewer:expired'));
    assert.equal((await f.route('delete', '/api/session/:sessionId')).status, 404);
  } finally { f.dispose(); }
});

test('failed deletion retains the session and leaves connected displays and ASR running', async () => {
  const f = fixture();
  const stream = f.startStream();
  f.failPersistence();
  try {
    assert.equal((await f.route('delete', '/api/session/:sessionId')).status, 500);
    assert.equal(f.hasSession(), true);
    assert.equal(stream.ready, true);
    assert.equal(stream.socket.readyState, 1);
    assert.equal(f.events.some(event => event.name === 'viewer:expired' || event.name === 'control:deleted'), false);
  } finally { f.dispose(); }
});

// Line breaks affect presentation, but must not interrupt matching spoken words.
test('automatic following matches speech across multiline subtitles', t => {
  const createAudioFixture = require('./helpers/audio-server-fixture');
  const f = createAudioFixture({ allowCueChanges: true, texts: [
    '我一直以為\n你不會再回來', '可是我答應過你',
  ] });
  t.after(() => f.dispose());
  f.transcript('我一直以為你不會再回來', {
    streamId: 'multiline', itemId: 'a', startMs: 0, endMs: 1000, isFinal: true,
  });
  assert.equal(f.state().preparedIndex, 1);
  assert.equal(f.state().progress, 1);
  f.transcript('可是我答應過你', {
    streamId: 'multiline', itemId: 'b', startMs: 1200, endMs: 2000, isFinal: true,
  });
  assert.equal(f.session.currentIndex, 1);
  assert.equal(f.session.subtitleControlMode, 'auto');
});
